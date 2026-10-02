import {
  COLLABORATION_ACTIVITY_KIND,
  CollaborationRequest,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownOption(CollaborationRequest);

export const collaborationStatusLabel = {
  queued: "Queued",
  starting: "Starting",
  processing: "Processing",
  "waiting-input": "Waiting for information",
  replied: "Replied",
  failed: "Failed",
} as const;

/** Select only the latest durable revision; both live updates and refreshed snapshots use this. */
export function collaborationRequestsFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<CollaborationRequest> {
  const requests = new Map<string, CollaborationRequest>();
  for (const activity of activities) {
    if (activity.kind !== COLLABORATION_ACTIVITY_KIND) continue;
    const decoded = decodeRequest(activity.payload);
    if (Option.isNone(decoded)) continue;
    const request = decoded.value;
    if ((requests.get(request.id)?.revision ?? -1) < request.revision)
      requests.set(request.id, request);
  }
  return [...requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
