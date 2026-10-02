import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import type {
  CollaborationParticipant,
  EnvironmentId,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import {
  collaborationRequestsFromActivities,
  collaborationStatusLabel,
} from "@t3tools/client-runtime/thread-collaboration";

function ParticipantLink({
  participant,
  environmentId,
}: {
  participant: CollaborationParticipant;
  environmentId: EnvironmentId;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: participant.threadId }}
      className="font-medium text-primary underline-offset-4 hover:underline"
      title={`${participant.projectName} · ${participant.cwd}\n${participant.threadId}`}
    >
      {participant.title}
    </Link>
  );
}

export function ThreadCollaboration({
  activities,
  environmentId,
  threadId,
}: {
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const requests = useMemo(() => collaborationRequestsFromActivities(activities), [activities]);
  if (requests.length === 0) return null;
  const active = requests.filter(
    (request) => request.status !== "replied" && request.status !== "failed",
  ).length;
  return (
    <details
      className="shrink-0 border-b border-border bg-muted/20 text-sm"
      data-testid="thread-collaboration"
    >
      <summary className="cursor-pointer px-4 py-2 text-muted-foreground">
        Thread collaboration · {requests.length} {requests.length === 1 ? "request" : "requests"}
        {active > 0 ? ` · ${active} active` : ""}
      </summary>
      <div className="max-h-72 space-y-2 overflow-y-auto px-4 pb-3">
        {requests.map((request) => (
          <details
            key={request.id}
            className="rounded-lg border border-border bg-background p-3"
            data-request-id={request.id}
          >
            <summary className="cursor-pointer space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <ParticipantLink participant={request.source} environmentId={environmentId} />
                <span aria-label="to">→</span>
                <ParticipantLink participant={request.target} environmentId={environmentId} />
                <span
                  className={
                    request.status === "failed" ? "text-destructive" : "text-muted-foreground"
                  }
                  role="status"
                >
                  {collaborationStatusLabel[request.status]}
                </span>
              </span>
              <span className="block truncate text-muted-foreground">
                {request.source.threadId === threadId ? "Sent" : "Received"} ·{" "}
                {request.messages[0]?.text}
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              <p className="break-all text-xs text-muted-foreground">Request {request.id}</p>
              {request.error ? (
                <p role="alert" className="text-destructive">
                  {request.error}
                </p>
              ) : null}
              {request.messages.map((message) => {
                const from =
                  message.fromThreadId === request.source.threadId
                    ? request.source
                    : request.target;
                const to =
                  message.toThreadId === request.source.threadId ? request.source : request.target;
                return (
                  <article
                    key={message.id}
                    className="space-y-1 border-l-2 border-border pl-3"
                    data-message-id={message.id}
                  >
                    <div className="flex flex-wrap gap-1 text-xs">
                      <ParticipantLink participant={from} environmentId={environmentId} />
                      <span>→</span>
                      <ParticipantLink participant={to} environmentId={environmentId} />
                      <span className="text-muted-foreground">
                        · {message.kind} · {message.delivery}
                      </span>
                    </div>
                    <p className="break-words whitespace-pre-wrap">{message.text}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      Message {message.id}
                      {message.inReplyTo ? ` · Reply to ${message.inReplyTo}` : ""}
                    </p>
                    {message.files ? (
                      <div className="break-all text-xs text-muted-foreground">
                        Working directory: {message.files.cwd}
                        <br />
                        {message.files.paths.join(", ")}
                        {message.files.changes ? (
                          <p className="whitespace-pre-wrap">{message.files.changes}</p>
                        ) : null}
                      </div>
                    ) : null}
                    {message.error ? (
                      <p className="text-xs text-destructive">{message.error}</p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
