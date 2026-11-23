// A member's verdict (README "A member's verdict", lead-verdict-edit): a member sets, changes or
// clears the verdict of one criterion of a lead's current snapshot, in the caller's tenant run (the
// request's for the route), under the person's lock. The snapshot is then decided again from its
// effective verdicts, the lead given the decision, and qualification.lead_qualified published when
// the lead's status changed. No model call and no credits; the model's verdict stays as it was.
import { getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../errors.ts";
import { CRITERIA, type Criterion } from "../schemas/assess-fit.ts";
import { type MemberVerdictBody, memberVerdictBody } from "../schemas/member-verdict.ts";
import { decidedAudience } from "./audience.ts";
import { publishDecision } from "./decision.ts";
import { lockPerson } from "./intent/store.ts";
import { rescoreMoved } from "./rescore.ts";
import { getSnapshot, type Snapshot } from "./score/get-snapshot.ts";
import { type MemberPart, writeMemberPart } from "./score/member.ts";
import { redecideSnapshot } from "./score/score-snapshot.ts";

/**
 * The member's verdict, with its note, on the criterion of the person's lead, who set it the run's
 * principal, at `at`: the snapshot read again. qualification_input_invalid (`details.fields`);
 * score_snapshot_not_found for a lead never scored, or one that waits for its new assessment
 * (README "A new assessment"); contacts' lead_not_found for a person without a lead, another
 * workspace's included.
 */
export async function setMemberVerdict(
  personId: string,
  criterion: string,
  input: MemberVerdictBody,
  at = new Date(),
): Promise<Snapshot> {
  const parsed = memberVerdictBody.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new AppError(errors.qualification_input_invalid, { details: { fields } });
  }
  const note = parsed.data.note?.trim() || null;
  const memberSetBy = currentTenant().principal.userId;
  const part = {
    memberVerdict: parsed.data.verdict,
    memberNote: note,
    memberSetBy,
    memberSetAt: at,
  };
  return edit(personId, criterion, part, at);
}

/** The member's verdict cleared: the model's counts again. Codes as setMemberVerdict's. */
export async function clearMemberVerdict(
  personId: string,
  criterion: string,
  at = new Date(),
): Promise<Snapshot> {
  return edit(personId, criterion, null, at);
}

async function edit(
  personId: string,
  criterion: string,
  part: MemberPart | null,
  at: Date,
): Promise<Snapshot> {
  const fields = [
    ...(typeof personId === "string" && personId.length > 0 && personId.length <= 64
      ? []
      : ["personId"]),
    ...(CRITERIA.includes(criterion as Criterion) ? [] : ["criterion"]),
  ];
  if (fields.length > 0) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields } });
  }
  // Before the lead is read, as scoreSnapshot: a batch or an intent update of the person waits.
  await lockPerson(personId);
  const audience = await decidedAudience(personId);
  const { criteria } = await readIcpForScoring(currentTenant().workspaceId, audience);
  if (!criteria.some(({ key }) => key === criterion)) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["criterion"] } });
  }
  // A lead scored by other criteria is re-scored first, so the edit decides with the criteria that
  // scored its snapshot.
  await rescoreMoved(personId, at);
  const lead = await getLead(personId);
  // A lead that waits keeps its snapshot for the new assessment, which takes the members' verdicts.
  const id = lead.qualificationStatus === "pending" ? null : lead.currentScoreSnapshotId;
  const select = { id: true, status: true } as const;
  const snapshot =
    id === null ? null : await tenantClient.scoreSnapshot.findFirst({ where: { id }, select });
  if (snapshot === null || snapshot.status === "assessed") {
    throw new AppError(errors.score_snapshot_not_found);
  }
  if (await writeMemberPart(snapshot.id, criterion as Criterion, part)) {
    const { status } = await redecideSnapshot(snapshot.id, at);
    if (status !== lead.qualificationStatus) await publishDecision(personId);
  }
  return getSnapshot(personId);
}
