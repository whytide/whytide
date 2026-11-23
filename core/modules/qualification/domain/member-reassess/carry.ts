// The members' verdicts a lead keeps through a member's new assessment (README "A new assessment"):
// a pending lead keeps the snapshot it waited with (index.ts), and the snapshot that decides it
// next against the same audience at the same version takes that one's members' verdicts, for the
// criteria the ICP still has, as the re-score's copy takes them (../score/member.ts). In the
// caller's tenant run, under the person's lock.
import { getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import type { Criterion } from "../../schemas/assess-fit.ts";
import { carryMemberParts, type VerdictRow } from "../score/member.ts";

/**
 * The verdict rows of the snapshot the person's pending lead waits with, when it is of the audience
 * `icpId` at `icpVersion`; null for a decided lead, or one waiting with none or one of another
 * audience or version. lead_not_found.
 */
export async function waitedVerdicts(
  personId: string,
  audience: { readonly icpId: string | null; readonly icpVersion: number },
): Promise<VerdictRow[] | null> {
  const lead = await getLead(personId);
  const id = lead.qualificationStatus === "pending" ? lead.currentScoreSnapshotId : null;
  if (id === null) return null;
  const select = { id: true } as const;
  const where = { id, icpId: audience.icpId, icpVersion: audience.icpVersion };
  const waited = await tenantClient.scoreSnapshot.findFirst({ where, select });
  if (waited === null) return null;
  return tenantClient.criterionVerdict.findMany({ where: { snapshotId: id } });
}

/**
 * The members' verdicts of the snapshot the lead waits with given to `snapshot`, the lead's new
 * assessment, for the criteria in `keep`: true when a row of it changed. lead_not_found.
 */
export async function carryWaiting(
  snapshot: {
    readonly id: string;
    readonly personId: string;
    readonly icpId: string | null;
    readonly icpVersion: number;
  },
  keep: ReadonlySet<Criterion>,
): Promise<boolean> {
  const rows = await waitedVerdicts(snapshot.personId, snapshot);
  return rows === null ? false : carryMemberParts(rows, snapshot.id, keep);
}
