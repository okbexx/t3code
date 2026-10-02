// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as Collaboration from "./ThreadCollaboration.ts";

const A = ThreadId.make("developer-a");
const B = ThreadId.make("reviewer-b");
const C = ThreadId.make("reviewer-c");
const project = ProjectId.make("project-a");
const instanceId = ProviderInstanceId.make("codex");
const timestamp = () => DateTime.formatIso(DateTime.nowUnsafe());
let commandSequence = 0;
const fixture = Effect.fn(function* (directory?: string) {
  const root =
    directory ??
    (yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-collaboration-test-")),
    ));
  if (!directory)
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  const services = Collaboration.layer.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provide(ProjectionThreadActivityRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(NodePath.join(root, "state.sqlite"))),
    Layer.provide(ServerConfig.layerTest(root, { prefix: "t3-collaboration-config-" })),
    Layer.provide(NodeServices.layer),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const context = yield* Layer.buildWithScope(services, scope);
  const service = Context.get(context, Collaboration.ThreadCollaboration);
  const engine = Context.get(context, OrchestrationEngineService);
  const query = Context.get(context, ProjectionSnapshotQuery);
  yield* service.start().pipe(Scope.provide(scope));
  const run = <A, E>(effect: Effect.Effect<A, E>) => effect;
  const session = (
    threadId: ThreadId,
    status: OrchestrationSessionStatus,
    turnId: string | null = null,
  ) =>
    run(
      engine
        .dispatch({
          type: "thread.session.set",
          threadId,
          createdAt: timestamp(),
          commandId: CommandId.make(`session-${++commandSequence}`),
          session: {
            threadId,
            status,
            activeTurnId: turnId ? TurnId.make(turnId) : null,
            providerName: "codex",
            runtimeMode: "full-access",
            lastError: status === "error" ? "Fixture provider disconnected" : null,
            updatedAt: timestamp(),
          },
        })
        .pipe(Effect.andThen(service.drain)),
    );
  if (!directory) {
    yield* run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("project"),
        projectId: project,
        title: "Development",
        workspaceRoot: root,
        defaultModelSelection: null,
        createdAt: timestamp(),
      }),
    );
    for (const id of [A, B, C])
      yield* run(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(id),
          threadId: id,
          projectId: project,
          title: id === A ? "Developer" : "Reviewer",
          modelSelection: { instanceId, model: "gpt-6-astra" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: timestamp(),
        }),
      );
  }
  yield* run(service.drain);
  return {
    root,
    dispose: Scope.close(scope, Exit.void),
    run,
    service,
    engine,
    query,
    session,
    send: Effect.fn(function* (key = "review", targetThreadId = B) {
      const sent = yield* run(
        service.send(A, { targetThreadId, idempotencyKey: key, text: `Review ${key}` }),
      );
      yield* run(service.drain);
      return sent.request.id;
    }),
    get: (id: string) => run(service.get(A, id)),
    events: () => run(Stream.runCollect(engine.readEvents(0, 10_000))),
  };
});

describe("independent thread collaboration", () => {
  it.effect(
    "discovers self and distinguishes same-name threads across project/worktree boundaries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const otherProject = ProjectId.make("project-b");
        const cwd = NodePath.join(f.root, "worktree-b");
        yield* Effect.promise(() => NodeFSP.mkdir(cwd));
        yield* f.run(
          f.engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("project-b"),
            projectId: otherProject,
            title: "Review",
            workspaceRoot: cwd,
            defaultModelSelection: null,
            createdAt: timestamp(),
          }),
        );
        yield* f.run(
          f.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("other-reviewer"),
            threadId: ThreadId.make("other-b"),
            projectId: otherProject,
            title: "Reviewer",
            modelSelection: { instanceId, model: "gpt-6-astra" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "review",
            worktreePath: cwd,
            createdAt: timestamp(),
          }),
        );
        const threads = yield* f.run(f.service.list(A, { query: "Reviewer" }));
        expect(threads.map((thread) => thread.threadId)).toHaveLength(3);
        expect((yield* f.run(f.service.list(A, { projectId: otherProject })))[0]).toMatchObject({
          threadId: "other-b",
          cwd,
          projectId: otherProject,
        });
        expect(
          (yield* f.run(f.service.list(A, {}))).find((thread) => thread.isSelf)?.threadId,
        ).toBe(A);
      }),
  );

  it.effect(
    "atomically submits to the normal turn pipeline, returns a correlated result, and resumes an idle source",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const id = yield* f.send();
        const events = yield* f.events();
        expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
          1,
        );
        const target = Option.getOrThrow(yield* f.run(f.query.getThreadDetailById(B)));
        expect(target.messages[0]?.text).toContain(`Request ID: ${id}`);
        expect(target.messages[0]?.context?.collaboration?.source.threadId).toBe(A);
        expect((yield* f.get(id)).request.status).toBe("starting");
        yield* f.session(B, "running", "review-turn");
        expect((yield* f.get(id)).request.status).toBe("processing");
        yield* f.run(
          f.service.respond(B, {
            requestId: id,
            messageId: "result",
            kind: "reply",
            text: "Use the validated patch.",
          }),
        );
        yield* f.run(f.service.drain);
        expect((yield* f.get(id)).request.status).toBe("replied");
        const source = Option.getOrThrow(yield* f.run(f.query.getThreadDetailById(A)));
        expect(source.messages.at(-1)?.text).toContain("Use the validated patch.");
        expect(source.activities.some((activity) => activity.kind === "thread.collaboration")).toBe(
          true,
        );
        expect(
          (yield* f.events()).filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(2);
      }),
  );

  it.effect("queues busy destinations FIFO without sending or interrupting their active task", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.session(B, "running", "original");
      const first = yield* f.send("first");
      const second = yield* f.send("second");
      expect(
        (yield* f.events()).filter(
          (event) =>
            event.type === "thread.turn-start-requested" ||
            event.type === "thread.turn-interrupt-requested",
        ),
      ).toHaveLength(0);
      expect((yield* f.get(first)).request.status).toBe("queued");
      yield* f.session(B, "ready");
      expect((yield* f.get(first)).request.status).toBe("starting");
      expect((yield* f.get(second)).request.status).toBe("queued");
      yield* f.session(B, "running", "first-turn");
      yield* f.run(
        f.service.respond(B, {
          requestId: first,
          messageId: "done",
          kind: "reply",
          text: "first result",
        }),
      );
      yield* f.session(B, "ready");
      expect((yield* f.get(second)).request.status).toBe("starting");
    }),
  );

  it.effect(
    "keeps user approval distinct from agent messages and reports blocking accurately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          f.engine.dispatch({
            type: "thread.activity.append",
            createdAt: timestamp(),
            commandId: CommandId.make("approval"),
            threadId: B,
            activity: {
              id: EventId.make("approval"),
              kind: "approval.requested",
              tone: "approval",
              summary: "Approve a command",
              payload: { requestId: "user-approval", requestKind: "command" },
              turnId: null,
              createdAt: timestamp(),
            },
          }),
        );
        const id = yield* f.send();
        expect((yield* f.get(id)).target?.state).toBe("waiting-user");
        expect((yield* f.get(id)).request.status).toBe("queued");
        const received = yield* f.run(f.service.wait(B, { requestId: id, timeoutMs: 0 }));
        expect(received.inbox).toHaveLength(0);
        expect(
          (yield* f.events()).filter(
            (event) =>
              event.type === "thread.approval-response-requested" ||
              event.type === "thread.turn-start-requested",
          ),
        ).toHaveLength(0);
      }),
  );

  it.effect(
    "delivers questions through an active wait and answers the same request without deadlock",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(A, "running", "source-turn");
        const id = yield* f.send();
        yield* f.session(B, "running", "target-turn");
        const before = (yield* f.get(id)).request.revision;
        const waiting = yield* f.service
          .wait(A, { requestId: id, afterRevision: before })
          .pipe(Effect.forkScoped);
        yield* f.run(
          f.service.respond(B, {
            requestId: id,
            messageId: "question",
            kind: "question",
            text: "Which base commit?",
          }),
        );
        const question = yield* Fiber.join(waiting);
        expect(question.inbox[0]?.message.id).toBe("question");
        expect(question.request.status).toBe("waiting-input");
        yield* f.run(
          f.service.respond(A, {
            requestId: id,
            messageId: "answer",
            kind: "answer",
            inReplyTo: "question",
            text: "Use abc123.",
          }),
        );
        const answer = yield* f.run(f.service.wait(B, { requestId: id, timeoutMs: 0 }));
        expect(answer.inbox[0]?.message.text).toBe("Use abc123.");
        yield* f.run(
          f.service.respond(B, {
            requestId: id,
            messageId: "result",
            kind: "reply",
            text: "Reviewed against abc123.",
          }),
        );
        const result = yield* f.run(f.service.wait(A, { requestId: id }));
        expect(result.request.status).toBe("replied");
        expect(result.inbox.at(-1)?.message.text).toContain("abc123");
        yield* f.run(f.service.drain);
        expect(
          (yield* f.events()).filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(1);
      }),
  );

  it.effect("receives reciprocal queued requests while both participants wait", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.session(A, "running", "a");
      yield* f.session(B, "running", "b");
      const first = yield* f.send();
      const second = yield* f.run(
        f.service.send(B, {
          targetThreadId: A,
          idempotencyKey: "reverse",
          text: "Need information",
        }),
      );
      const fromB = yield* f.run(f.service.wait(A, { requestId: first, timeoutMs: 0 }));
      const fromA = yield* f.run(f.service.wait(B, { requestId: second.request.id, timeoutMs: 0 }));
      expect(fromB.inbox[0]?.request.id).toBe(second.request.id);
      expect(fromA.inbox[0]?.request.id).toBe(first);
      expect(
        (yield* f.events()).filter((event) => event.type === "thread.turn-start-requested"),
      ).toHaveLength(0);
    }),
  );

  it.effect(
    "deduplicates retries, rejects key conflicts, and keeps timeout separate from delivery",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(B, "running", "busy");
        const [first, again] = yield* Effect.all([f.send(), f.send()], {
          concurrency: "unbounded",
        });
        expect(first).toBe(again);
        const waiting = yield* f.run(f.service.wait(A, { requestId: first, timeoutMs: 0 }));
        expect(waiting.timedOut).toBe(true);
        expect(waiting.request.status).toBe("queued");
        expect(
          (yield* Effect.flip(
            f.run(
              f.service.send(A, {
                targetThreadId: C,
                idempotencyKey: "review",
                text: "Review review",
              }),
            ),
          )).message,
        ).toContain("different request");
        expect((yield* Effect.flip(f.run(f.service.get(C, first)))).message).toContain(
          "participants",
        );
        yield* f.session(B, "ready");
        expect(
          (yield* f.events()).filter((event) => event.type === "thread.turn-start-requested"),
        ).toHaveLength(1);
      }),
  );

  it.effect(
    "preserves exact cross-worktree file context and rejects unavailable working directories",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const sent = yield* f.run(
          f.service.send(A, {
            targetThreadId: C,
            idempotencyKey: "files",
            text: "Review this diff",
            files: {
              cwd: "/other/project/worktree",
              paths: ["src/index.ts"],
              changes: "base abc123; head def456",
            },
          }),
        );
        yield* f.run(f.service.drain);
        const thread = Option.getOrThrow(yield* f.run(f.query.getThreadDetailById(C)));
        expect(thread.messages[0]?.text).toContain("/other/project/worktree");
        expect(thread.messages[0]?.text).toContain("src/index.ts");
        expect((yield* f.get(sent.request.id)).request.messages[0]?.files?.cwd).toBe(
          "/other/project/worktree",
        );
      }),
  );

  it.effect(
    "fails a queued request when its destination is deleted and never reports provider failure as a reply",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(B, "running", "busy");
        const queued = yield* f.send();
        yield* f.run(
          f.engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete"),
            threadId: B,
          }),
        );
        yield* f.run(f.service.drain);
        expect((yield* f.get(queued)).request.status).toBe("failed");
        expect((yield* Effect.flip(f.send("missing", B))).message).toContain("unavailable");
        const running = yield* f.send("provider-error", C);
        yield* f.session(C, "error");
        expect((yield* f.get(running)).request).toMatchObject({
          status: "failed",
          error: "Fixture provider disconnected",
        });
      }),
  );

  it.effect("does not cross-wire concurrent results or automatically acknowledge completion", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.session(A, "running", "source");
      const b = yield* f.send("b", B);
      const c = yield* f.send("c", C);
      yield* f.run(
        f.service.respond(C, { requestId: c, messageId: "done", kind: "reply", text: "C result" }),
      );
      expect(
        (yield* Effect.flip(
          f.run(
            f.service.respond(B, {
              requestId: c,
              messageId: "wrong",
              kind: "reply",
              text: "wrong",
            }),
          ),
        )).message,
      ).toContain("participants");
      yield* f.run(
        f.service.respond(B, { requestId: b, messageId: "done", kind: "reply", text: "B result" }),
      );
      const reply = { requestId: b, messageId: "done", kind: "reply" as const, text: "B result" };
      yield* f.run(f.service.respond(B, reply));
      expect(
        (yield* Effect.flip(
          f.run(
            f.service.respond(A, { requestId: b, messageId: "ack", kind: "reply", text: "Thanks" }),
          ),
        )).message,
      ).toContain("complete");
      const results = yield* f.run(f.service.wait(A, { requestId: b }));
      expect(results.inbox.map((entry) => [entry.request.id, entry.message.text])).toEqual(
        expect.arrayContaining([
          [b, "B result"],
          [c, "C result"],
        ]),
      );
      expect(
        (yield* f.get(b)).request.messages.filter((message) => message.kind === "reply"),
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "restores durable records and marks ambiguous in-flight work after restart without redelivery",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture();
        const id = yield* first.send();
        yield* first.session(B, "running", "in-flight");
        const before = (yield* first.events()).filter(
          (event) => event.type === "thread.turn-start-requested",
        ).length;
        yield* first.dispose;
        const recovered = yield* fixture(first.root);
        yield* recovered.run(recovered.service.drain);
        expect((yield* recovered.get(id)).request.status).toBe("failed");
        expect((yield* recovered.get(id)).request.error).toContain("restarted");
        expect(
          (yield* recovered.events()).filter(
            (event) => event.type === "thread.turn-start-requested",
          ),
        ).toHaveLength(before);
        const thread = Option.getOrThrow(
          yield* recovered.run(recovered.query.getThreadDetailById(A)),
        );
        expect(
          thread.activities.find((entry) => entry.kind === "thread.collaboration")?.payload,
        ).toMatchObject({ id, status: "failed" });
      }),
  );
  it.effect(
    "preserves queued FIFO through restart and retries the original request without a second turn",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture();
        yield* first.session(B, "running", "original");
        const one = yield* first.send("one");
        const two = yield* first.send("two");
        yield* first.dispose;
        const restored = yield* fixture(first.root);
        expect((yield* restored.get(one)).request.status).toBe("queued");
        yield* restored.session(B, "ready");
        expect((yield* restored.get(one)).request.status).toBe("starting");
        expect((yield* restored.get(two)).request.status).toBe("queued");
        expect(yield* restored.send("one")).toBe(one);
        expect(
          (yield* restored.events()).filter(
            (event) => event.type === "thread.turn-start-requested",
          ),
        ).toHaveLength(1);
      }),
  );

  it.effect("never treats a collaboration message as a pending user-input answer", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("user-input"),
        threadId: B,
        createdAt: timestamp(),
        activity: {
          id: EventId.make("user-input"),
          kind: "user-input.requested",
          tone: "approval",
          summary: "User decision",
          payload: {
            requestId: "user-question",
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Choose deployment?",
                options: [
                  { label: "Yes", description: "Deploy" },
                  { label: "No", description: "Do not deploy" },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: timestamp(),
        },
      });
      const id = yield* f.send();
      expect((yield* f.get(id)).target?.state).toBe("waiting-user");
      expect((yield* f.service.wait(B, { requestId: id, timeoutMs: 0 })).inbox).toHaveLength(0);
      expect(
        (yield* f.events()).filter(
          (event) =>
            event.type === "thread.user-input-response-requested" ||
            event.type === "thread.turn-start-requested",
        ),
      ).toHaveLength(0);
      yield* f.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("user-input-resolved"),
        threadId: B,
        createdAt: timestamp(),
        activity: {
          id: EventId.make("user-input-resolved"),
          kind: "user-input.resolved",
          tone: "info",
          summary: "User answered",
          payload: { requestId: "user-question", answers: { choice: "No" } },
          turnId: null,
          createdAt: timestamp(),
        },
      });
      yield* f.service.drain;
      expect((yield* f.get(id)).request.status).toBe("starting");
    }),
  );

  it.effect(
    "rejects an archived target but can restart a stopped provider for an open thread",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(B, "stopped");
        const id = yield* f.send();
        expect((yield* f.get(id)).request.status).toBe("starting");
        yield* f.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-c"),
          threadId: C,
        });
        expect((yield* Effect.flip(f.send("closed", C))).code).toBe("unavailable");
      }),
  );

  it.effect("rejects unavailable worktrees before acknowledging delivery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("missing-worktree"),
        threadId: B,
        worktreePath: NodePath.join(f.root, "deleted-worktree"),
      });
      expect((yield* Effect.flip(f.send())).code).toBe("unavailable");
      expect(
        (yield* f.events()).filter((event) => event.type === "thread.turn-start-requested"),
      ).toHaveLength(0);
    }),
  );

  it.effect(
    "rejects an answer to a previous question even when the same participant owes the next answer",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(A, "running", "a");
        const id = yield* f.send();
        yield* f.session(B, "running", "b");
        yield* f.service.respond(B, {
          requestId: id,
          messageId: "first-question",
          kind: "question",
          text: "First?",
        });
        yield* f.service.wait(A, { requestId: id, timeoutMs: 0 });
        yield* f.service.respond(A, {
          requestId: id,
          messageId: "first-answer",
          kind: "answer",
          inReplyTo: "first-question",
          text: "One",
        });
        yield* f.service.wait(B, { requestId: id, timeoutMs: 0 });
        yield* f.service.respond(B, {
          requestId: id,
          messageId: "second-question",
          kind: "question",
          text: "Second?",
        });
        expect(
          (yield* Effect.flip(
            f.service.respond(A, {
              requestId: id,
              messageId: "stale-answer",
              kind: "answer",
              inReplyTo: "first-question",
              text: "Stale",
            }),
          )).code,
        ).toBe("invalid-state");
        expect((yield* f.get(id)).request.status).toBe("waiting-input");
      }),
  );

  it.effect("does not declare a request successful merely because its provider turned idle", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const id = yield* f.send();
      yield* f.session(B, "running", "b");
      yield* f.session(B, "ready");
      expect((yield* f.get(id)).request.status).toBe("failed");
      expect((yield* f.get(id)).request.error).toContain("without returning a reply");
    }),
  );

  it.effect(
    "retains collaboration records after unrelated activities exceed the normal history window",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.session(B, "running", "busy");
        const id = yield* f.send();
        for (let i = 0; i < 505; i++)
          yield* f.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`noise-${i}`),
            threadId: A,
            createdAt: timestamp(),
            activity: {
              id: EventId.make(`noise-${i}`),
              tone: "info",
              kind: "fixture.noise",
              summary: "Unrelated activity",
              payload: {},
              turnId: null,
              createdAt: timestamp(),
            },
          });
        const refreshed = Option.getOrThrow(yield* f.query.getThreadDetailSnapshot(A));
        expect(
          refreshed.thread.activities.find((activity) => activity.kind === "thread.collaboration")
            ?.payload,
        ).toMatchObject({ id, status: "queued" });
      }),
  );
});
