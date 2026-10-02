import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadCollaboration from "../../../orchestration/ThreadCollaboration.ts";
import { CollaborationToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const collaboration = yield* ThreadCollaboration.ThreadCollaboration;
  const caller = McpInvocationContext.requireMcpCapability("collaboration").pipe(
    Effect.map((scope) => scope.threadId),
  );
  return CollaborationToolkit.of({
    list_collaboration_threads: (input) =>
      Effect.gen(function* () {
        const selfThreadId = yield* caller;
        return { selfThreadId, threads: yield* collaboration.list(selfThreadId, input) };
      }),
    send_thread_request: (input) => Effect.flatMap(caller, (id) => collaboration.send(id, input)),
    get_thread_request: (input) =>
      Effect.flatMap(caller, (id) => collaboration.get(id, input.requestId)),
    respond_to_thread_request: (input) =>
      Effect.flatMap(caller, (id) => collaboration.respond(id, input)),
    wait_for_thread_request: (input) =>
      Effect.flatMap(caller, (id) => collaboration.wait(id, input)),
  });
});

export const CollaborationToolkitHandlersLive = CollaborationToolkit.toLayer(make);
