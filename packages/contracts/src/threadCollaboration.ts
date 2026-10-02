import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectId, ThreadId, TurnId } from "./baseSchemas.ts";

export const COLLABORATION_ACTIVITY_KIND = "thread.collaboration";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(32_000));
const Key = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const CollaborationParticipant = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  cwd: Schema.String,
  provider: Schema.String,
});
export type CollaborationParticipant = typeof CollaborationParticipant.Type;

export const CollaborationFileContext = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  changes: Schema.optional(Text),
});

export const CollaborationMessage = Schema.Struct({
  id: Key,
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
  kind: Schema.Literals(["request", "question", "answer", "reply", "context"]),
  text: Text,
  files: Schema.optional(CollaborationFileContext),
  inReplyTo: Schema.NullOr(Key),
  delivery: Schema.Literals(["queued", "starting", "processing", "delivered", "failed"]),
  turnId: Schema.NullOr(TurnId),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type CollaborationMessage = typeof CollaborationMessage.Type;

export const CollaborationRequest = Schema.Struct({
  id: Key,
  idempotencyKey: Key,
  source: CollaborationParticipant,
  target: CollaborationParticipant,
  status: Schema.Literals([
    "queued",
    "starting",
    "processing",
    "waiting-input",
    "replied",
    "failed",
  ]),
  waitingForThreadId: Schema.NullOr(ThreadId),
  messages: Schema.Array(CollaborationMessage),
  error: Schema.NullOr(Schema.String),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CollaborationRequest = typeof CollaborationRequest.Type;

export const CollaborationSendInput = Schema.Struct({
  targetThreadId: ThreadId,
  idempotencyKey: Key.annotate({
    description:
      "Choose once per task and reuse on retries, including after a timeout or lost connection.",
  }),
  text: Text,
  files: Schema.optional(CollaborationFileContext),
});
export type CollaborationSendInput = typeof CollaborationSendInput.Type;

export const CollaborationRespondInput = Schema.Struct({
  requestId: Key,
  messageId: Key.annotate({ description: "Choose once for this response and reuse on retries." }),
  kind: Schema.Literals(["question", "answer", "reply", "context"]),
  text: Text,
  inReplyTo: Schema.optional(
    Key.annotate({ description: "The exact question message ID when answering." }),
  ),
  files: Schema.optional(CollaborationFileContext),
});
export type CollaborationRespondInput = typeof CollaborationRespondInput.Type;

export const CollaborationThread = Schema.Struct({
  ...CollaborationParticipant.fields,
  isSelf: Schema.Boolean,
  state: Schema.Literals(["idle", "working", "waiting-user", "unavailable"]),
  reason: Schema.NullOr(Schema.String),
});
export type CollaborationThread = typeof CollaborationThread.Type;

export const CollaborationListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  query: Schema.optional(Schema.String),
});
export type CollaborationListInput = typeof CollaborationListInput.Type;

export const CollaborationProgress = Schema.Struct({
  request: CollaborationRequest,
  target: Schema.NullOr(CollaborationThread),
});
export type CollaborationProgress = typeof CollaborationProgress.Type;

export const CollaborationWaitInput = Schema.Struct({
  requestId: Key,
  afterRevision: Schema.optional(NonNegativeInt),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 25_000 }))),
});
export type CollaborationWaitInput = typeof CollaborationWaitInput.Type;

export const CollaborationWaitResult = Schema.Struct({
  ...CollaborationProgress.fields,
  timedOut: Schema.Boolean,
  inbox: Schema.Array(
    Schema.Struct({ request: CollaborationRequest, message: CollaborationMessage }),
  ),
});
export type CollaborationWaitResult = typeof CollaborationWaitResult.Type;

export class CollaborationError extends Schema.TaggedError<CollaborationError>()(
  "CollaborationError",
  {
    code: Schema.Literals([
      "not-found",
      "unavailable",
      "forbidden",
      "conflict",
      "invalid-state",
      "persistence",
    ]),
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
