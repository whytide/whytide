// scoreSnapshot, the command the batch (alpha-p6-040) calls after assessPerson (README.md "Public
// interface", docs/flows.md "The score"). It runs in the caller's tenant run and opens none, as
// contacts' commands do, so that the snapshot's scores, its verdicts' weights and points and the
// lead's decision commit together, with whatever else the caller writes in that run. The criteria
// are the ICP's at scoring time: a criteria save re-scores nothing here (decisions.md, 2026-10-22);
// the re-score (rescore.ts) scores a copy of the snapshot.
import { applyQualification, getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { Disqualifier } from "../../schemas/assess-fit.ts";
import { buildWhy } from "../why/index.ts";
import { criteriaHash } from "./criteria-hash.ts";
import {
  type Confidence,
  computeFit,
  counting,
  decide,
  firstDisqualifier,
  pointsOf,
  SCORER_VERSION,
  type ScoreStatus,
  type Tier,
} from "./index.ts";

export type ScoreResult = {
  readonly snapshotId: string;
  readonly personId: string;
  readonly status: ScoreStatus;
  readonly fitScore: number;
  readonly confidence: Confidence;
  readonly tier: Tier;
  /** The disqualifier that the lead's status_reason names, or null. */
  readonly reason: Disqualifier | null;
};
/** What this command reads of a snapshot row. */
type SnapshotRow = {
  readonly id: string;
  readonly personId: string;
  readonly status: ScoreStatus | "assessed";
  readonly fitScore: number | null;
  readonly confidence: Confidence | null;
  readonly tier: Tier | null;
  readonly icpVersion: number;
  readonly disqualifiers: readonly Disqualifier[];
  readonly createdAt: Date;
};
type WhyParts = Parameters<typeof buildWhy>[0];

/**
 * The snapshot scored under fit-v1, with the hash of the criteria that scored it, and the person's
 * lead given the decision (no tier when not_qualified), the why, the snapshot and the ICP's version,
 * in the caller's tenant run. A scored snapshot answers what it stored and
 * changes nothing, so a retried activity gets the same result; a lead whose current snapshot is newer
 * keeps it. qualification_input_invalid; score_snapshot_not_found; icp_version_stale when the ICP
 * moved since the assessment; contacts' lead_not_found, which rolls the caller's run back.
 */
export async function scoreSnapshot(snapshotId: string): Promise<ScoreResult> {
  if (typeof snapshotId !== "string" || snapshotId.length === 0 || snapshotId.length > 64) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["snapshotId"] } });
  }
  const id = snapshotId;
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  if (snapshot.status !== "assessed") return resultOf(snapshot);
  const { icp, criteria } = await readIcpForScoring(currentTenant().workspaceId);
  if (icp.version !== snapshot.icpVersion) {
    const details = { icp_version: snapshot.icpVersion, current_version: icp.version };
    throw new AppError(errors.icp_version_stale, { details });
  }
  const verdicts = await tenantClient.criterionVerdict.findMany({ where: { snapshotId: id } });
  const { personId, disqualifiers } = snapshot;
  const { fit, confidence } = computeFit(verdicts, criteria);
  const { status, tier, reason } = decide({ fit, confidence, disqualifiers, verdicts, criteria });
  const scoredCriteriaHash = criteriaHash(criteria);
  const scores = { scorerVersion: SCORER_VERSION, fitScore: fit, confidence, tier, status };
  const data = { ...scores, scoredCriteriaHash };
  const where = { id, status: "assessed" as const };
  const { count } = await tenantClient.scoreSnapshot.updateMany({ where, data });
  if (count === 0) {
    // Another run scored it after the read and committed first: its result stands.
    return resultOf(await tenantClient.scoreSnapshot.findFirstOrThrow({ where: { id } }));
  }
  const weights = new Map(counting(verdicts, criteria).map((v) => [v.criterion, v.weight]));
  for (const { criterion, verdict } of verdicts) {
    const data = { weight: weights.get(criterion) ?? 0, points: pointsOf(verdict) };
    await tenantClient.criterionVerdict.updateMany({ where: { snapshotId: id, criterion }, data });
  }
  const result = { snapshotId: id, personId, status, fitScore: fit, confidence, tier, reason };
  if (!(await outdated(snapshot))) await decideLead(snapshot, result, verdicts, criteria);
  return result;
}

/**
 * A scored snapshot's decision given to its lead again, whatever snapshot the lead points at: the
 * re-score's way back to criteria it scored before (domain/rescore.ts). score_snapshot_not_found.
 */
export async function reapplySnapshot(snapshotId: string): Promise<ScoreResult> {
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id: snapshotId } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  if (snapshot.status === "assessed") return scoreSnapshot(snapshotId);
  const { criteria } = await readIcpForScoring(currentTenant().workspaceId);
  const verdicts = await tenantClient.criterionVerdict.findMany({ where: { snapshotId } });
  const result = resultOf(snapshot);
  await decideLead(snapshot, result, verdicts, criteria);
  return result;
}

/** The lead given the decision, the why, the snapshot and its ICP version. */
async function decideLead(
  snapshot: SnapshotRow,
  result: ScoreResult,
  verdicts: WhyParts["verdicts"],
  criteria: WhyParts["criteria"],
) {
  const { status, fitScore, confidence, reason } = result;
  const why = buildWhy({ verdicts, criteria, disqualifiers: snapshot.disqualifiers });
  // A tier ranks leads worth contacting: a not_qualified lead has none; the snapshot keeps it.
  const tier = status === "not_qualified" ? undefined : result.tier;
  const decision = { status, fitScore, confidence, tier, why, reason: reason ?? undefined };
  const { personId, id: snapshotId, icpVersion } = snapshot;
  await applyQualification({ personId, ...decision, snapshotId, icpVersion });
}

/**
 * Whether the person's lead points at a snapshot newer than this one (created later, ties by id): a
 * late run never moves the lead back. contacts' lead_not_found.
 */
async function outdated(snapshot: SnapshotRow): Promise<boolean> {
  const current = (await getLead(snapshot.personId)).currentScoreSnapshotId;
  if (current === null || current === snapshot.id) return false;
  const select = { id: true, createdAt: true } as const;
  const other = await tenantClient.scoreSnapshot.findFirst({ where: { id: current }, select });
  if (other === null) return false;
  const later = other.createdAt.getTime() - snapshot.createdAt.getTime();
  return later > 0 || (later === 0 && other.id > snapshot.id);
}

/** A scored snapshot's result as stored; scoring wrote the four fields together. */
function resultOf(row: SnapshotRow): ScoreResult {
  const { id: snapshotId, personId } = row;
  return {
    snapshotId,
    personId,
    status: row.status as ScoreStatus,
    fitScore: row.fitScore as number,
    confidence: row.confidence as Confidence,
    tier: row.tier as Tier,
    reason: firstDisqualifier(row.disqualifiers),
  };
}
