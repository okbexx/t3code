import * as NodeCrypto from "node:crypto";
import {
  COLLABORATION_ACTIVITY_KIND,
  CollaborationError,
  CollaborationFileContext,
  CollaborationRequest,
  CommandId,
  MessageId,
  type CollaborationListInput,
  type CollaborationMessage,
  type CollaborationParticipant,
  type CollaborationProgress,
  type CollaborationRespondInput,
  type CollaborationSendInput,
  type CollaborationThread,
  type CollaborationWaitInput,
  type CollaborationWaitResult,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";

export class ThreadCollaboration extends Context.Service<
  ThreadCollaboration,
  {
    readonly list: (
      caller: ThreadId,
      input: CollaborationListInput,
    ) => Effect.Effect<ReadonlyArray<CollaborationThread>, CollaborationError>;
    readonly send: (
      caller: ThreadId,
      input: CollaborationSendInput,
    ) => Effect.Effect<CollaborationProgress, CollaborationError>;
    readonly respond: (
      caller: ThreadId,
      input: CollaborationRespondInput,
    ) => Effect.Effect<CollaborationProgress, CollaborationError>;
    readonly get: (
      caller: ThreadId,
      requestId: string,
    ) => Effect.Effect<CollaborationProgress, CollaborationError>;
    readonly wait: (
      caller: ThreadId,
      input: CollaborationWaitInput,
    ) => Effect.Effect<CollaborationWaitResult, CollaborationError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadCollaboration") {}

const failure = (code: CollaborationError["code"], detail: string) =>
  new CollaborationError({ code, detail });
const persistenceFailure = () =>
  failure(
    "persistence",
    "Could not persist collaboration state. Query the original request before retrying with the same idempotency key.",
  );
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const sameFiles = Schema.toEquivalence(Schema.UndefinedOr(CollaborationFileContext));
const encodeFiles = Schema.encodeSync(Schema.fromJsonString(CollaborationFileContext));
const decodeRequest = Schema.decodeUnknownEffect(CollaborationRequest);
const isRequest = Schema.is(CollaborationRequest);
const terminal = (request: CollaborationRequest) =>
  request.status === "replied" || request.status === "failed";
const participant = (request: CollaborationRequest, id: ThreadId) =>
  request.source.threadId === id ? request.source : request.target;
const participantFacts = ({
  threadId,
  title,
  projectId,
  projectName,
  cwd,
  provider,
}: CollaborationParticipant): CollaborationParticipant => ({
  threadId,
  title,
  projectId,
  projectName,
  cwd,
  provider,
});
const deliveryMessageId = (request: CollaborationRequest, message: CollaborationMessage) =>
  MessageId.make(`collaboration:${request.id}:${message.id}`);

/** Explicit provenance travels with every delivery, including across projects and worktrees. */
function deliveryPrompt(request: CollaborationRequest, message: CollaborationMessage): string {
  const from = participant(request, message.fromThreadId);
  return [
    "[T3 Code thread collaboration — an agent message, not a user answer or approval]",
    `Request ID: ${request.id}; message ID: ${message.id}; kind: ${message.kind}.`,
    `From: ${from.title} (${from.threadId}); project: ${from.projectName} (${from.projectId}); working directory: ${from.cwd}.`,
    `Your thread ID: ${message.toThreadId}.`,
    message.inReplyTo ? `In reply to message: ${message.inReplyTo}.` : "",
    message.files
      ? `File context (resolve paths against this directory, not your own): ${encodeFiles(message.files)}`
      : "",
    "Only the following explicitly supplied context was shared:",
    message.text,
    message.kind === "reply"
      ? "Use this result to continue the original user task. This request is complete; do not acknowledge it with another collaboration reply."
      : "Process this in your own thread context. Use respond_to_thread_request with this requestId to return a reply, ask a question, or answer the exact question message ID. A chat response alone does not return the result. After asking a question, use wait_for_thread_request or end your turn; the answer will resume you. Never answer a user's pending approval through collaboration.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const activities = yield* ProjectionThreadActivityRepository;
  const fs = yield* FileSystem.FileSystem;
  const mutex = yield* Semaphore.make(1);
  const requests = new Map<string, CollaborationRequest>();
  let changed = yield* Deferred.make<void>();
  let observedSequence = yield* engine.latestSequence;
  let observed = yield* Deferred.make<void>();
  const recovered = yield* Deferred.make<void, CollaborationError>();
  let started = false;
  const rows = yield* activities.listByKind(COLLABORATION_ACTIVITY_KIND).pipe(Effect.orDie);
  for (const row of rows) {
    const request = yield* decodeRequest(row.payload).pipe(Effect.orDie);
    if ((requests.get(request.id)?.revision ?? -1) < request.revision)
      requests.set(request.id, request);
  }

  // Strictly increasing envelope times keep FIFO stable for simultaneous sends
  // and across restarts, even when the wall clock moves backwards.
  let messageMillis = 0;
  for (const request of requests.values())
    for (const message of request.messages)
      messageMillis = Math.max(messageMillis, Date.parse(message.createdAt));
  const nextMessageTime = Effect.gen(function* () {
    messageMillis = Math.max(messageMillis + 1, yield* Clock.currentTimeMillis);
    return DateTime.formatIso(DateTime.makeUnsafe(messageMillis));
  });

  const save = Effect.fn("ThreadCollaboration.save")(function* (
    request: CollaborationRequest,
    delivery?: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) {
    const next = { ...request, revision: request.revision + 1, updatedAt: yield* now };
    yield* engine.dispatch({
      type: "thread.collaboration.record",
      commandId: CommandId.make(`collaboration:${request.id}:${NodeCrypto.randomUUID()}`),
      threadId: request.source.threadId,
      request: next,
      ...(delivery ? { delivery } : {}),
    });
    requests.set(next.id, next);
    const previous = changed;
    changed = yield* Deferred.make<void>();
    yield* Deferred.succeed(previous, undefined);
    return next;
  }, Effect.uninterruptible);

  const list = Effect.fn("ThreadCollaboration.list")(function* (
    caller: ThreadId,
    input: CollaborationListInput,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const timestamp = yield* now;
    return snapshot.threads.flatMap((thread): CollaborationThread[] => {
      const project = snapshot.projects.find((entry) => entry.id === thread.projectId);
      if (!project || (input.projectId && input.projectId !== project.id)) return [];
      const cwd = thread.worktreePath ?? project.workspaceRoot;
      if (
        input.query &&
        ![thread.id, thread.title, project.title, cwd].some((value) =>
          value.toLowerCase().includes(input.query!.toLowerCase()),
        )
      )
        return [];
      const session = thread.session;
      const unavailable = thread.archivedAt !== null || session?.status === "error";
      const blocked = thread.hasPendingApprovals || thread.hasPendingUserInput;
      const working =
        session?.status === "starting" ||
        session?.status === "running" ||
        thread.backgroundLiveness != null ||
        threadHasQueuedTurnStart(thread, timestamp);
      return [
        {
          threadId: thread.id,
          title: thread.title,
          projectId: project.id,
          projectName: project.title,
          cwd,
          provider: session?.providerName ?? thread.modelSelection.instanceId,
          isSelf: thread.id === caller,
          state: unavailable
            ? "unavailable"
            : blocked
              ? "waiting-user"
              : working
                ? "working"
                : "idle",
          reason: unavailable
            ? (session?.lastError ?? "Thread is closed or unavailable.")
            : blocked
              ? "Waiting for user input or approval; agent messages remain queued."
              : null,
        },
      ];
    });
  }, Effect.mapError(persistenceFailure));

  const requireRequest = (caller: ThreadId, requestId: string) =>
    Effect.gen(function* () {
      const request = requests.get(requestId);
      if (!request) return yield* failure("not-found", `Request ${requestId} does not exist.`);
      if (caller !== request.source.threadId && caller !== request.target.threadId)
        return yield* failure(
          "forbidden",
          "Only this request's participants may read or respond to it.",
        );
      return request;
    });
  const progress = Effect.fn("ThreadCollaboration.progress")(function* (
    caller: ThreadId,
    request: CollaborationRequest,
  ) {
    const threads = yield* list(caller, {});
    return {
      request,
      target: threads.find((thread) => thread.threadId === request.target.threadId) ?? null,
    };
  });
  const get = Effect.fn("ThreadCollaboration.get")(function* (caller: ThreadId, requestId: string) {
    return yield* progress(caller, yield* requireRequest(caller, requestId));
  });

  const markFailed = (request: CollaborationRequest, detail: string) =>
    save({
      ...request,
      status: request.status === "replied" ? "replied" : "failed",
      error: detail,
      messages: request.messages.map((message) =>
        message.delivery === "queued" ||
        message.delivery === "starting" ||
        message.delivery === "processing"
          ? { ...message, delivery: "failed" as const, error: detail }
          : message,
      ),
    });

  const reconcile = Effect.fn("ThreadCollaboration.reconcile")(function* (
    event?: OrchestrationEvent,
  ) {
    if (event?.type === "thread.session-set") {
      const session = event.payload.session;
      for (const request of requests.values()) {
        const processing = request.messages.find(
          (message) =>
            message.toThreadId === session.threadId &&
            (message.delivery === "starting" || message.delivery === "processing"),
        );
        if (!processing) continue;
        if (
          session.status === "running" &&
          session.activeTurnId !== null &&
          processing.turnId === null
        ) {
          yield* save({
            ...request,
            status: request.status === "starting" ? "processing" : request.status,
            messages: request.messages.map((message) =>
              message.id === processing.id
                ? { ...message, delivery: "processing" as const, turnId: session.activeTurnId }
                : message,
            ),
          });
        } else if (
          session.status === "error" ||
          session.status === "interrupted" ||
          session.status === "stopped"
        ) {
          yield* markFailed(
            request,
            session.lastError ?? `Provider ${session.status} while handling collaboration.`,
          );
        } else if (session.status === "ready" && processing.turnId !== null) {
          if (
            !terminal(request) &&
            request.status !== "waiting-input" &&
            processing.toThreadId === request.target.threadId
          ) {
            yield* markFailed(
              request,
              "The provider turn ended without returning a reply. The task was not automatically repeated.",
            );
          } else {
            yield* save({
              ...request,
              messages: request.messages.map((message) =>
                message.id === processing.id
                  ? { ...message, delivery: "delivered" as const }
                  : message,
              ),
            });
          }
        }
      }
    }
    if (
      ![...requests.values()].some(
        (request) =>
          !terminal(request) ||
          request.messages.some(
            (message) =>
              message.delivery === "queued" ||
              message.delivery === "starting" ||
              message.delivery === "processing",
          ),
      )
    )
      return;
    const threads = yield* list(requests.values().next().value!.source.threadId, {});
    for (const request of requests.values()) {
      if (terminal(request)) continue;
      const requiredThreadId = request.waitingForThreadId ?? request.target.threadId;
      const required = threads.find((thread) => thread.threadId === requiredThreadId);
      if (!required || required.state === "unavailable")
        yield* markFailed(
          request,
          required?.reason ?? "Destination thread was archived, deleted, or is unavailable.",
        );
    }
    const reserved = new Set<ThreadId>();
    for (const request of requests.values())
      for (const message of request.messages)
        if (message.delivery === "starting" || message.delivery === "processing")
          reserved.add(message.toThreadId);
    // Order every envelope, not just its parent request: a later answer cannot
    // jump ahead of an earlier independent task. IDs break equal timestamp ties.
    const pending = [...requests.values()]
      .flatMap((request) =>
        request.messages
          .filter((message) => message.delivery === "queued")
          .map((message) => ({ requestId: request.id, message })),
      )
      .sort(
        (a, b) =>
          a.message.createdAt.localeCompare(b.message.createdAt) ||
          a.requestId.localeCompare(b.requestId) ||
          a.message.id.localeCompare(b.message.id),
      );
    for (const { requestId, message } of pending) {
      const request = requests.get(requestId)!;
      if (request.status === "failed") continue;
      const target = threads.find((thread) => thread.threadId === message.toThreadId);
      if (!target || target.state === "unavailable") {
        yield* markFailed(
          request,
          target?.reason ?? "Destination thread was archived, deleted, or is unavailable.",
        );
        continue;
      }
      if (reserved.has(target.threadId) || target.state !== "idle") continue;
      if (!(yield* fs.exists(target.cwd))) {
        yield* markFailed(request, `Destination working directory is unavailable: ${target.cwd}`);
        continue;
      }
      const shell = yield* snapshots.getThreadShellById(target.threadId);
      if (Option.isNone(shell)) continue;
      const timestamp = yield* now;
      const next = {
        ...request,
        status:
          message.kind === "request" || message.kind === "answer"
            ? ("starting" as const)
            : request.status,
        messages: request.messages.map((entry) =>
          entry.id === message.id ? { ...entry, delivery: "starting" as const } : entry,
        ),
      };
      yield* save(next, {
        type: "thread.turn.start",
        commandId: CommandId.make(`collaboration-delivery:${request.id}:${message.id}`),
        threadId: target.threadId,
        message: {
          messageId: deliveryMessageId(request, message),
          role: "user",
          text: deliveryPrompt(request, message),
          attachments: [],
          context: {
            version: 1,
            records: [],
            collaboration: {
              requestId: request.id,
              messageId: message.id,
              kind: message.kind,
              source: participant(request, message.fromThreadId),
              text: message.text,
            },
          },
        },
        runtimeMode: shell.value.runtimeMode,
        interactionMode: shell.value.interactionMode,
        createdAt: timestamp,
      }).pipe(Effect.catchTag("OrchestrationCommandInvariantError", () => Effect.void));
      reserved.add(target.threadId);
    }
  });
  const worker = yield* makeDrainableWorker((event: OrchestrationEvent | undefined) =>
    reconcile(event).pipe(
      mutex.withPermits(1),
      Effect.catchCause((cause) => Effect.logError("Collaboration scheduling failed", { cause })),
    ),
  );

  const send = Effect.fn("ThreadCollaboration.send")(function* (
    caller: ThreadId,
    input: CollaborationSendInput,
  ) {
    const request = yield* Effect.gen(function* () {
      const id = NodeCrypto.createHash("sha256")
        .update(`${caller.length}:${caller}${input.idempotencyKey}`)
        .digest("hex");
      const existing = requests.get(id);
      if (existing) {
        const message = existing.messages[0]!;
        if (
          existing.target.threadId !== input.targetThreadId ||
          message.text !== input.text ||
          !sameFiles(message.files, input.files)
        )
          return yield* failure(
            "conflict",
            "This idempotency key already belongs to a different request.",
          );
        return existing;
      }
      if (caller === input.targetThreadId)
        return yield* failure(
          "invalid-state",
          "Select another thread; self-messaging is not collaboration.",
        );
      const threads = yield* list(caller, {});
      const source = threads.find((thread) => thread.threadId === caller);
      const target = threads.find((thread) => thread.threadId === input.targetThreadId);
      if (!source || !target || source.state === "unavailable" || target.state === "unavailable")
        return yield* failure(
          "unavailable",
          "Source or destination thread is closed, deleted, or unavailable.",
        );
      if (!(yield* fs.exists(target.cwd).pipe(Effect.mapError(persistenceFailure))))
        return yield* failure(
          "unavailable",
          `Destination working directory is unavailable: ${target.cwd}`,
        );
      const timestamp = yield* nextMessageTime;
      const record: CollaborationRequest = {
        id,
        idempotencyKey: input.idempotencyKey,
        source: participantFacts(source),
        target: participantFacts(target),
        status: "queued",
        waitingForThreadId: null,
        error: null,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [
          {
            id: "request",
            fromThreadId: caller,
            toThreadId: target.threadId,
            kind: "request",
            text: input.text,
            ...(input.files ? { files: input.files } : {}),
            inReplyTo: null,
            delivery: "queued",
            turnId: null,
            error: null,
            createdAt: timestamp,
          },
        ],
      };
      return yield* save(record).pipe(Effect.mapError(persistenceFailure));
    }).pipe(mutex.withPermits(1));
    return yield* progress(caller, request);
  });

  const respond = Effect.fn("ThreadCollaboration.respond")(function* (
    caller: ThreadId,
    input: CollaborationRespondInput,
  ) {
    const request = yield* Effect.gen(function* () {
      const request = yield* requireRequest(caller, input.requestId);
      const duplicate = request.messages.find((message) => message.id === input.messageId);
      if (duplicate) {
        if (
          duplicate.fromThreadId !== caller ||
          duplicate.kind !== input.kind ||
          duplicate.text !== input.text ||
          duplicate.inReplyTo !== (input.inReplyTo ?? null) ||
          !sameFiles(duplicate.files, input.files)
        )
          return yield* failure(
            "conflict",
            "This message ID already belongs to a different response.",
          );
        return request;
      }
      if (terminal(request))
        return yield* failure(
          "invalid-state",
          "This request is complete; status notifications must not create automatic reply loops.",
        );
      if (input.kind === "reply" && caller !== request.target.threadId)
        return yield* failure(
          "forbidden",
          "Only the delegated thread may return the final result.",
        );
      if (input.kind === "question" && request.waitingForThreadId !== null)
        return yield* failure(
          "invalid-state",
          "Answer the outstanding question before asking another.",
        );
      const other =
        caller === request.source.threadId ? request.target.threadId : request.source.threadId;
      if (input.kind === "answer") {
        const question = request.messages.findLast((message) => message.kind === "question");
        if (
          !question ||
          question.id !== input.inReplyTo ||
          question.toThreadId !== caller ||
          request.waitingForThreadId !== caller
        )
          return yield* failure(
            "invalid-state",
            "Answer the exact outstanding question message ID addressed to this thread.",
          );
      }
      const timestamp = yield* nextMessageTime;
      const message: CollaborationMessage = {
        id: input.messageId,
        fromThreadId: caller,
        toThreadId: other,
        kind: input.kind,
        text: input.text,
        ...(input.files ? { files: input.files } : {}),
        inReplyTo: input.inReplyTo ?? null,
        delivery: "queued",
        turnId: null,
        error: null,
        createdAt: timestamp,
      };
      return yield* save({
        ...request,
        status:
          input.kind === "reply"
            ? "replied"
            : input.kind === "question"
              ? "waiting-input"
              : input.kind === "answer"
                ? "queued"
                : request.status,
        waitingForThreadId:
          input.kind === "question"
            ? other
            : input.kind === "answer" || input.kind === "reply"
              ? null
              : request.waitingForThreadId,
        messages: [
          ...request.messages.map((entry) =>
            input.kind !== "context" &&
            entry.toThreadId === caller &&
            (entry.delivery === "starting" || entry.delivery === "processing")
              ? { ...entry, delivery: "delivered" as const }
              : entry,
          ),
          message,
        ],
      }).pipe(Effect.mapError(persistenceFailure));
    }).pipe(mutex.withPermits(1));
    return yield* progress(caller, request);
  });

  // A waiting agent explicitly receives its inbox in the current turn. This breaks
  // reciprocal waits without steering a busy provider or impersonating user input.
  const receive = Effect.fn("ThreadCollaboration.receive")(function* (caller: ThreadId) {
    const inbox: Array<CollaborationWaitResult["inbox"][number]> = [];
    const threads = yield* list(caller, {});
    const own = threads.find((thread) => thread.threadId === caller);
    if (!own || own.state === "waiting-user" || own.state === "unavailable") return inbox;
    const shell = yield* snapshots
      .getThreadShellById(caller)
      .pipe(Effect.mapError(persistenceFailure));
    const turnId = Option.getOrNull(shell)?.session?.activeTurnId ?? null;
    for (const request of requests.values()) {
      const pending = request.messages.filter(
        (message) => message.toThreadId === caller && message.delivery === "queued",
      );
      if (pending.length === 0 || request.status === "failed") continue;
      const next = yield* save({
        ...request,
        status: request.status === "queued" ? "processing" : request.status,
        messages: request.messages.map((message) =>
          pending.includes(message)
            ? {
                ...message,
                delivery:
                  message.kind === "request" || message.kind === "answer"
                    ? ("processing" as const)
                    : ("delivered" as const),
                turnId,
              }
            : message,
        ),
      }).pipe(Effect.mapError(persistenceFailure));
      inbox.push(...pending.map((message) => ({ request: next, message })));
    }
    return inbox;
  });
  const wait = Effect.fn("ThreadCollaboration.wait")(function* (
    caller: ThreadId,
    input: CollaborationWaitInput,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? 25_000);
    const initial = yield* requireRequest(caller, input.requestId);
    const revision = input.afterRevision ?? initial.revision;
    while (true) {
      const signal = changed;
      const inbox = yield* receive(caller).pipe(mutex.withPermits(1));
      const current = yield* get(caller, input.requestId);
      if (
        inbox.length > 0 ||
        terminal(current.request) ||
        current.request.waitingForThreadId === caller ||
        current.request.revision > revision
      )
        return { ...current, timedOut: false, inbox };
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return { ...current, timedOut: true, inbox };
      const result = yield* Deferred.await(signal).pipe(Effect.timeoutOption(remaining));
      if (Option.isNone(result))
        return { ...(yield* get(caller, input.requestId)), timedOut: true, inbox: [] };
    }
  });

  const start = Effect.fn("ThreadCollaboration.start")(function* () {
    if (started) return;
    started = true;
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          for (const request of requests.values()) {
            if (
              (!terminal(request) && request.status !== "queued") ||
              request.messages.some(
                (message) => message.delivery === "starting" || message.delivery === "processing",
              )
            ) {
              yield* markFailed(
                request,
                "Server restarted during processing. Delivery may have run; it will not be repeated automatically.",
              );
            }
          }
        }).pipe(
          mutex.withPermits(1),
          Effect.catchCause((cause) =>
            Effect.logError("Collaboration recovery failed", { cause }).pipe(
              Effect.andThen(Deferred.fail(recovered, persistenceFailure())),
              Effect.andThen(Effect.never),
            ),
          ),
        );
        yield* Deferred.succeed(recovered, undefined);
        yield* worker.enqueue(undefined);
        yield* Stream.runForEach(events, (event) =>
          Effect.gen(function* () {
            if (
              event.type === "thread.session-set" ||
              event.type === "thread.archived" ||
              event.type === "thread.deleted" ||
              event.type === "project.deleted" ||
              (event.type === "thread.activity-appended" &&
                ((event.payload.activity.kind === COLLABORATION_ACTIVITY_KIND &&
                  isRequest(event.payload.activity.payload) &&
                  event.payload.activity.payload.source.threadId === event.payload.threadId) ||
                  event.payload.activity.kind === "approval.resolved" ||
                  event.payload.activity.kind === "user-input.resolved"))
            )
              yield* worker.enqueue(event);
            observedSequence = event.sequence;
            const signal = observed;
            observed = yield* Deferred.make<void>();
            yield* Deferred.succeed(signal, undefined);
          }),
        );
      }),
    );
  });
  const drain = Effect.gen(function* () {
    yield* Deferred.await(recovered).pipe(Effect.orDie);
    const through = yield* engine.latestSequence;
    while (true) {
      if (observedSequence >= through) break;
      yield* Deferred.await(observed);
    }
    yield* worker.drain;
  });
  return {
    list: (caller, input) => Deferred.await(recovered).pipe(Effect.andThen(list(caller, input))),
    send: (caller, input) => Deferred.await(recovered).pipe(Effect.andThen(send(caller, input))),
    respond: (caller, input) =>
      Deferred.await(recovered).pipe(Effect.andThen(respond(caller, input))),
    get: (caller, id) => Deferred.await(recovered).pipe(Effect.andThen(get(caller, id))),
    wait: (caller, input) => Deferred.await(recovered).pipe(Effect.andThen(wait(caller, input))),
    start,
    drain,
  } satisfies ThreadCollaboration["Service"];
});

export const layer = Layer.effect(ThreadCollaboration, make);
