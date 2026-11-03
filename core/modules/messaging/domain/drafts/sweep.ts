// The sweep (README.md "The workflow"; docs/flows.md "The sweep"), in the caller's tenant run: every
// draft of either kind still `drafting` more than DRAFT_STUCK_MINUTES after it was made has no run
// left to write it (a cancelled one, or one past its attempts), and ends `failed`, draft_stuck, with
// no text. The write is conditional on `drafting`, as the writer's is (write.ts): whichever writes
// first wins, and a run that answers later drops its answer. A step's draft publishes
// messaging.step_draft_ready in the same run.
import { outboxWriter, tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { DRAFT_STUCK_MINUTES, MS_PER_MINUTE } from "./constants.ts";
import { publishStepDraftEnds } from "./store.ts";

/** Fails the workspace's stuck drafts and answers how many. */
export async function sweepStuckDrafts(now: Date = new Date()): Promise<{ stuck: number }> {
  const madeBefore = new Date(now.getTime() - DRAFT_STUCK_MINUTES * MS_PER_MINUTE);
  const where = { status: "drafting" as const, createdAt: { lt: madeBefore } };
  const data = { status: "failed" as const, text: null, flagReasons: [{ code: "draft_stuck" }] };
  const select = { id: true, stepExecutionId: true } as const;
  const stuck = await tenantClient.messageDraft.updateManyAndReturn({ where, data, select });
  const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
  await publishStepDraftEnds(outbox, stuck, "failed");
  return { stuck: stuck.length };
}
