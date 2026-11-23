// A member's new assessment of a lead (README "A new assessment", docs/flows.md): the lead page's
// Re-score puts a decided lead back to pending, whatever its status, and the batch assesses it again
// with the person's fields as they are now, a member's edits included, for one assessment's credits.
// The press moves the lead's attempt to the next round (rounds.ts), so that its reservation is under
// a key no reservation used and the provider's failures count afresh. When nothing the assessment
// reads changed, the model's answer cache gives back a snapshot scored already: the batch then
// decides the lead again from that snapshot (decideAgain) and commits the reservation at quantity 0,
// no credits. The lead keeps its snapshot while it waits, for the members' verdicts on it
// (carry.ts); the lead page reads none of a pending lead (../score/get-snapshot.ts). Each runs in the
// caller's tenant run.
import { applyQualification, getLead } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant, isAppError, publish } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { reassessParams } from "../../schemas/reassess.ts";
import { audienceOfLead } from "../audience.ts";
import { lockPerson } from "../intent/store.ts";
import { rescoreMoved } from "../rescore.ts";
import { carryMemberParts } from "../score/member.ts";
import { reapplySnapshot, redecideSnapshot } from "../score/score-snapshot.ts";
import { waitedVerdicts } from "./carry.ts";
import { MEMBER_REQUESTED } from "./constants.ts";
import { nextRound } from "./rounds.ts";

/**
 * A member's press, under the person's lock: a decided lead back to pending with status_reason
 * member_requested, its snapshot kept, its attempt against its audience (../audience.ts) at that
 * audience's current version moved to the next round, and qualification.reassess_requested, whose
 * subscriber starts the workspace's batch. A pending lead waits already and stays as it is:
 * `requested` false. The review, the enrollment and
 * the intent row stay as they are. qualification_input_invalid; contacts' lead_not_found, another
 * workspace's person included.
 */
export async function requestReassess(
  personId: string,
): Promise<{ status: "pending"; requested: boolean }> {
  if (!reassessParams.safeParse({ personId }).success) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["personId"] } });
  }
  // Before the lead is read, as scoreSnapshot: a batch or an intent update of the person waits.
  await lockPerson(personId);
  const lead = await getLead(personId);
  if (lead.qualificationStatus === "pending") return { status: "pending", requested: false };
  const { workspaceId } = currentTenant();
  const icpId = await audienceOfLead(lead);
  const { icp } = await readIcpForScoring(workspaceId, icpId);
  await startRound(personId, icp.id, icp.version);
  const snapshotId = lead.currentScoreSnapshotId ?? undefined;
  await applyQualification({ personId, status: "pending", reason: MEMBER_REQUESTED, snapshotId });
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["qualification.reassess_requested"], { workspaceId, personId });
  return { status: "pending", requested: true };
}

/**
 * Whether the batch's assessment gave a snapshot scored already for a lead that waits: only the
 * model's answer cache gives one back, so no model call was made. Under the person's lock.
 */
export async function cacheAnswered(snapshotId: string): Promise<boolean> {
  const select = { personId: true, status: true } as const;
  const snapshot = await tenantClient.scoreSnapshot.findFirst({
    where: { id: snapshotId },
    select,
  });
  if (snapshot === null || snapshot.status === "assessed") return false;
  await lockPerson(snapshot.personId);
  const lead = await getLead(snapshot.personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  return lead?.qualificationStatus === "pending";
}

/**
 * The waiting lead decided again from `snapshotId`, its snapshot that the cache gave back, under the
 * person's lock, with the intent at `at`: the lead given its decision, re-scored when other criteria
 * scored it (../rescore.ts), then the members' verdicts of the snapshot it waited with carried to
 * the one that took it, which is decided again when they changed it. No model call, no event.
 * score_snapshot_not_found; icp_version_stale, before any write, when the ICP moved since.
 */
export async function decideAgain(snapshotId: string, at = new Date()): Promise<void> {
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id: snapshotId } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  const { personId, icpId, icpVersion } = snapshot;
  await lockPerson(personId);
  const { workspaceId } = currentTenant();
  const { icp, criteria } = await readIcpForScoring(workspaceId, icpId ?? undefined);
  if (icp.version !== icpVersion) {
    const details = { icp_version: icpVersion, current_version: icp.version };
    throw new AppError(errors.icp_version_stale, { details });
  }
  // Read before the lead leaves pending: it points at the snapshot it waited with until then.
  const waited = await waitedVerdicts(personId, { icpId, icpVersion });
  await reapplySnapshot(snapshotId, at);
  await rescoreMoved(personId, at);
  const current = (await getLead(personId)).currentScoreSnapshotId;
  if (waited === null || current === null) return;
  const keys = new Set(criteria.map(({ key }) => key));
  if (await carryMemberParts(waited, current, keys)) await redecideSnapshot(current, at);
}

/**
 * The person's attempt against the audience `icpId` at `icpVersion` moved to the first of the next
 * round, made when it has none.
 */
async function startRound(personId: string, icpId: string, icpVersion: number) {
  const { workspaceId } = currentTenant();
  const where = { personId, icpId, icpVersion };
  const stored = await tenantClient.assessmentAttempt.findFirst({ where });
  const attempt = nextRound(stored?.attempt ?? 1);
  const data = [{ workspaceId, ...where, attempt }];
  await tenantClient.assessmentAttempt.createMany({ data, skipDuplicates: true });
  // A row the batch wrote since the read moves too; one past it already stays.
  await tenantClient.assessmentAttempt.updateMany({
    where: { ...where, attempt: { lt: attempt } },
    data: { attempt },
  });
}
