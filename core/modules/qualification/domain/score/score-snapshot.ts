// scoreSnapshot, the command the batch (alpha-p6-040) calls after assessPerson (README.md "Public
// interface", docs/flows.md "The score"). It runs in the caller's tenant run and opens none, as
// contacts' commands do, so that the snapshot's scores, its verdicts' weights and points and the
// lead's decision commit together, with whatever else the caller writes in that run. The criteria
// are those of the snapshot's audience at scoring time (gamma-p5-050): a criteria save re-scores
// nothing here (decisions.md, 2026-10-22); the re-score (rescore.ts) scores a copy of the snapshot.
// With a signal reader registered, the lead's tier is its priority's and its why names its
// strongest signal (README "Intent and priority"): updateIntent gives the lead's decision again
// with the intent of now, under the person's lock. An intent write that takes the lead into Hot
// publishes qualification.lead_hot in the same run (README "The Hot alert"). Every score and why
// reads the verdicts' effective values: a member's verdict counts instead of the model's while set,
// and redecideSnapshot decides a scored snapshot again after a member's edit (member.ts, README "A
// member's verdict"). A lead that waits for a member's new assessment keeps the members' verdicts
// of the snapshot it waited with (README "A new assessment").
import { applyQualification, getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { readIcpForScoring } from "@whytide/icp";
import { AppError, currentTenant, isAppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { Disqualifier } from "../../schemas/assess-fit.ts";
import { publishLeadHot } from "../alert/publish.ts";
import { leadTier, withWhyNow } from "../intent/index.ts";
import { dropIntent, intentOf, lockPerson, writeIntent } from "../intent/store.ts";
import { carryWaiting } from "../member-reassess/carry.ts";
import { signalReader } from "../signal-reader.ts";
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
  type ScoringCriterion,
  type Tier,
} from "./index.ts";
import { type EffectiveVerdict, readVerdicts } from "./member.ts";

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
  /** The audience it was assessed against; null on a row of the previous release: the default. */
  readonly icpId: string | null;
  readonly icpVersion: number;
  readonly disqualifiers: readonly Disqualifier[];
  readonly createdAt: Date;
};
type WhyParts = Parameters<typeof buildWhy>[0];
/** The lead statuses a decision gives, each with a snapshot: those an intent ranks. */
const DECIDED: ReadonlySet<string> = new Set(["qualified", "not_qualified", "needs_review"]);

/**
 * The snapshot scored under fit-v1 with its audience's criteria, with the hash of the criteria that
 * scored it, and the person's lead given the decision (no tier when not_qualified), the why, the
 * snapshot and the audience with its version, in the caller's tenant run, under the person's lock;
 * with a reader, the intent at `at` too. A lead that waits gives the snapshot the members' verdicts
 * of the one it waited with, at this version, first (../member-reassess/carry.ts). A scored
 * snapshot answers what it stored and changes nothing, so a retried activity gets the same result;
 * a lead whose current snapshot is newer keeps it. The result's tier is the fit's, which the
 * snapshot keeps. qualification_input_invalid; score_snapshot_not_found; icp_version_stale when the
 * ICP moved since the assessment; contacts' lead_not_found, which rolls the caller's run back.
 */
export async function scoreSnapshot(snapshotId: string, at = new Date()): Promise<ScoreResult> {
  if (typeof snapshotId !== "string" || snapshotId.length === 0 || snapshotId.length > 64) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["snapshotId"] } });
  }
  const id = snapshotId;
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  if (snapshot.status !== "assessed") return resultOf(snapshot);
  // Before the lead is read: an intent update of the person waits for this run, or this for it.
  await lockPerson(snapshot.personId);
  const { icp, criteria } = await audienceOf(snapshot);
  if (icp.version !== snapshot.icpVersion) {
    const details = { icp_version: snapshot.icpVersion, current_version: icp.version };
    throw new AppError(errors.icp_version_stale, { details });
  }
  await carryWaiting(snapshot, new Set(criteria.map(({ key }) => key)));
  const { verdicts } = await readVerdicts(id);
  const { personId } = snapshot;
  const { fit, confidence, status, tier, reason } = scoresOf(verdicts, criteria, snapshot);
  const scoredCriteriaHash = criteriaHash(criteria);
  const scores = { scorerVersion: SCORER_VERSION, fitScore: fit, confidence, tier, status };
  const data = { ...scores, scoredCriteriaHash };
  const where = { id, status: "assessed" as const };
  const { count } = await tenantClient.scoreSnapshot.updateMany({ where, data });
  if (count === 0) {
    // Another run scored it after the read and committed first: its result stands.
    return resultOf(await tenantClient.scoreSnapshot.findFirstOrThrow({ where: { id } }));
  }
  await writeVerdictScores(id, verdicts, criteria);
  const result = { snapshotId: id, personId, status, fitScore: fit, confidence, tier, reason };
  if (!(await outdated(snapshot))) {
    await decideLead(snapshot, result, { verdicts, criteria, icpId: icp.id }, at);
  }
  return result;
}

/**
 * A scored snapshot's decision given to its lead again, whatever snapshot the lead points at, under
 * the person's lock, with the intent at `at`: the re-score's way back to criteria it scored before
 * (domain/rescore.ts). score_snapshot_not_found.
 */
export async function reapplySnapshot(snapshotId: string, at = new Date()): Promise<ScoreResult> {
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id: snapshotId } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  if (snapshot.status === "assessed") return scoreSnapshot(snapshotId, at);
  await lockPerson(snapshot.personId);
  const { icp, criteria } = await audienceOf(snapshot);
  const { verdicts } = await readVerdicts(snapshotId);
  const result = resultOf(snapshot);
  await decideLead(snapshot, result, { verdicts, criteria, icpId: icp.id }, at);
  return result;
}

/**
 * A scored snapshot decided again in place from its effective verdicts with the current criteria,
 * after a member's verdict changed (README "A member's verdict"): its fit, confidence, tier and
 * status, its verdicts' weights and points, then its lead given the decision, whatever snapshot the
 * lead points at, under the person's lock, with the intent at `at`. The criteria hash that scored
 * it stays, so the re-score's keys stay unique. No model call. score_snapshot_not_found.
 */
export async function redecideSnapshot(snapshotId: string, at = new Date()): Promise<ScoreResult> {
  const snapshot = await tenantClient.scoreSnapshot.findFirst({ where: { id: snapshotId } });
  if (snapshot === null) throw new AppError(errors.score_snapshot_not_found);
  if (snapshot.status === "assessed") return scoreSnapshot(snapshotId, at);
  await lockPerson(snapshot.personId);
  const { icp, criteria } = await audienceOf(snapshot);
  const { verdicts } = await readVerdicts(snapshotId);
  const { fit, confidence, status, tier, reason } = scoresOf(verdicts, criteria, snapshot);
  const data = { fitScore: fit, confidence, tier, status };
  await tenantClient.scoreSnapshot.updateMany({ where: { id: snapshotId }, data });
  await writeVerdictScores(snapshotId, verdicts, criteria);
  const { personId } = snapshot;
  const result = { snapshotId, personId, status, fitScore: fit, confidence, tier, reason };
  const parts = { verdicts, criteria, icpId: icp.id };
  await decideLead({ ...snapshot, ...data }, result, parts, at);
  return result;
}

/**
 * The person's intent at `at`, in the caller's tenant run, under the person's lock: the lead's
 * decision given again from its current snapshot, its status, fit and audience as they are, with
 * the tier of the new priority and the why with the new why-now bullet, by its audience's criteria.
 * No lead_qualified event: the status does not move; lead_hot when the lead enters Hot. A person
 * with no lead, or a lead without a decision, loses its row. False when nothing was computed: no
 * reader, or no decision.
 */
export async function updateIntent(personId: string, at = new Date()): Promise<boolean> {
  if (signalReader() === undefined) return false;
  await lockPerson(personId);
  const lead = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  const decided = lead !== null && DECIDED.has(lead.qualificationStatus);
  const id = decided ? lead.currentScoreSnapshotId : null;
  const snapshot =
    id === null ? null : await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (id === null || snapshot === null || snapshot.status === "assessed") {
    await dropIntent(personId);
    return false;
  }
  const { criteria } = await audienceOf(snapshot);
  const { verdicts } = await readVerdicts(id);
  // The audience the lead holds, written again as it is: this write sends every field.
  const parts = { verdicts, criteria, icpId: lead?.icpIdScored ?? undefined };
  await decideLead(snapshot, resultOf(snapshot), parts, at);
  return true;
}

/** The audience the snapshot was assessed against, its ICP and criteria: the default for a null. */
function audienceOf(snapshot: Pick<SnapshotRow, "icpId">) {
  return readIcpForScoring(currentTenant().workspaceId, snapshot.icpId ?? undefined);
}

/** fit-v1's fit, confidence and decision from the effective verdicts and the criteria. */
function scoresOf(
  verdicts: readonly EffectiveVerdict[],
  criteria: readonly ScoringCriterion[],
  { disqualifiers }: Pick<SnapshotRow, "disqualifiers">,
) {
  const { fit, confidence } = computeFit(verdicts, criteria);
  const { status, tier, reason } = decide({ fit, confidence, disqualifiers, verdicts, criteria });
  return { fit, confidence, status, tier, reason };
}

/** Each verdict row's weight in this fit (0 when its criterion is off) and its effective points. */
async function writeVerdictScores(
  snapshotId: string,
  verdicts: readonly EffectiveVerdict[],
  criteria: readonly ScoringCriterion[],
) {
  const weights = new Map(counting(verdicts, criteria).map((v) => [v.criterion, v.weight]));
  for (const { criterion, verdict } of verdicts) {
    const data = { weight: weights.get(criterion) ?? 0, points: pointsOf(verdict) };
    await tenantClient.criterionVerdict.updateMany({ where: { snapshotId, criterion }, data });
  }
}

/**
 * The lead given the decision, the why, the snapshot, the audience `icpId` and its version; with a
 * reader, the tier of the priority, the why-now bullet, and then the person's row, with
 * qualification.lead_hot when the write takes the lead into Hot. The caller holds the person's
 * lock.
 */
async function decideLead(
  snapshot: SnapshotRow,
  result: ScoreResult,
  parts: Pick<WhyParts, "verdicts" | "criteria"> & { readonly icpId: string | undefined },
  at: Date,
) {
  const { verdicts, criteria, icpId } = parts;
  const { status, fitScore, confidence, reason } = result;
  const { personId, id: snapshotId, icpVersion } = snapshot;
  const intent = await intentOf(personId, fitScore, at);
  const fitWhy = buildWhy({ verdicts, criteria, disqualifiers: snapshot.disqualifiers });
  const why = withWhyNow(fitWhy, intent?.whyNow ?? null);
  // A tier ranks leads worth contacting: a not_qualified lead has none; the snapshot keeps the
  // fit's.
  const ranked = status === "not_qualified" ? null : result.tier;
  const tier = intent === null ? ranked : leadTier(status, intent.priority);
  const decision = { status, fitScore, confidence, tier: tier ?? undefined, why };
  const scored = { snapshotId, icpId, icpVersion, reason: reason ?? undefined };
  await applyQualification({ personId, ...decision, ...scored });
  if (intent !== null && (await writeIntent(personId, intent, tier, at))) {
    await publishLeadHot(personId);
  }
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
