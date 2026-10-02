import {
  CollaborationError,
  CollaborationListInput,
  CollaborationProgress,
  CollaborationRespondInput,
  CollaborationSendInput,
  CollaborationThread,
  CollaborationWaitInput,
  CollaborationWaitResult,
  McpCapabilityUnavailableError,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadCollaboration from "../../../orchestration/ThreadCollaboration.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadCollaboration.ThreadCollaboration,
];
const failure = Schema.Union([CollaborationError, McpCapabilityUnavailableError]);
const List = Tool.make("list_collaboration_threads", {
  description:
    "Discover independent T3 Code threads in this server, across projects and worktrees. Returns your own stable thread ID, exact destination IDs, projects, working directories, provider and current state. Route by threadId, never by name or UI focus. Closed/deleted threads are not destinations. No conversation history is shared.",
  parameters: CollaborationListInput,
  success: Schema.Struct({ selfThreadId: ThreadId, threads: Schema.Array(CollaborationThread) }),
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const Send = Tool.make("send_thread_request", {
  description:
    "Delegate work or send a question to another independent thread. Choose an idempotencyKey once for this task and reuse it on every retry. Acceptance is durable, not completion. Busy or user-blocked destinations queue FIFO without interrupting or approving their current work. Provide only needed context, and an explicit cwd for file paths. Use get_thread_request or wait_for_thread_request for the returned request ID. A reply resumes you after your current turn if you do not receive it while waiting.",
  parameters: CollaborationSendInput,
  success: CollaborationProgress,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const Get = Tool.make("get_thread_request", {
  description:
    "Read this specific collaboration request, its correlated messages, delivery state and destination run state. A target becoming idle does not complete a request; only status replied confirms a result. A wait timeout never cancels or duplicates delivery. Only participants can read a request.",
  parameters: Schema.Struct({ requestId: TrimmedNonEmptyString }),
  success: CollaborationProgress,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const Respond = Tool.make("respond_to_thread_request", {
  description:
    "Respond within an existing request: kind reply returns the delegated result (recipient only); question asks the other participant for missing information; answer must identify the exact question with inReplyTo; context supplies additional context. Reuse messageId on retries. After asking, call wait_for_thread_request or finish your turn so the answer can resume you. Do not create a new request to answer an existing one. Never substitute an agent response for a user's approval. A completed request cannot be replied to again.",
  parameters: CollaborationRespondInput,
  success: CollaborationProgress,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const Wait = Tool.make("wait_for_thread_request", {
  description:
    "Wait up to 25 seconds for this request's revision to change, a reply, or an incoming message. Returns timedOut independently of delivery status. This also explicitly receives your queued collaboration inbox in the current turn: handle each returned message using its own request ID, including questions or reciprocal tasks, before waiting again. This prevents reciprocal waiting deadlocks. Read the result even on timeout; never resend with a new key. To wait for another change, pass the returned request.revision as afterRevision. You may end your turn instead; queued replies/questions then resume you automatically. Ordinary state changes never send automatic acknowledgements.",
  parameters: CollaborationWaitInput,
  success: CollaborationWaitResult,
  failure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const CollaborationToolkit = Toolkit.make(List, Send, Get, Respond, Wait);
