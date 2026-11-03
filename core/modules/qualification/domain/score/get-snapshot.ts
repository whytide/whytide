// getSnapshot, the read behind the lead page (README.md "Public interface", docs/flows.md "The lead
// page's read"): the lead's current snapshot as scoreSnapshot left it, its six verdicts in the
// criteria's order. It runs in the caller's tenant run, the request's for the route, and opens none.
import { getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import {
  CRITERIA,
  type Criterion,
  type Disqualifier,
  type Verdict,
} from "../../schemas/assess-fit.ts";
import type { Confidence, ScoreStatus, Tier } from "./index.ts";

export type SnapshotVerdict = {
  readonly criterion: Criterion;
  readonly verdict: Verdict;
  /** The model's quote of the profile; empty when unknown. */
  readonly evidence: string;
  /** The criterion's weight in the fit and the verdict's points, 0 to 1; null until scored. */
  readonly weight: number | null;
  readonly points: number | null;
};
export type Snapshot = {
  readonly snapshotId: string;
  readonly personId: string;
  readonly status: ScoreStatus | "assessed";
  readonly fitScore: number | null;
  readonly confidence: Confidence | null;
  readonly tier: Tier | null;
  readonly icpVersion: number;
  readonly scorerVersion: string | null;
  /** The model's one sentence about the fit. */
  readonly summary: string;
  readonly disqualifiers: readonly Disqualifier[];
  readonly verdicts: readonly SnapshotVerdict[];
  /** When the snapshot was stored, right before it was scored: the table keeps no other time. */
  readonly scoredAt: Date;
};

/**
 * The current snapshot of the person's lead. qualification_input_invalid; score_snapshot_not_found
 * when the lead has none (pending, stopped by the hard filters, ai_failed); contacts'
 * lead_not_found when the person has no lead in the workspace, another workspace's person included.
 */
export async function getSnapshot(personId: string): Promise<Snapshot> {
  if (typeof personId !== "string" || personId.length === 0 || personId.length > 64) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["personId"] } });
  }
  const id = (await getLead(personId)).currentScoreSnapshotId;
  const row = id === null ? null : await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (row === null) throw new AppError(errors.score_snapshot_not_found);
  const rows = await tenantClient.criterionVerdict.findMany({ where: { snapshotId: row.id } });
  const verdicts = rows
    .map(({ criterion, verdict, evidence, weight, points }) => {
      return { criterion, verdict, evidence, weight, points: points === null ? null : +points };
    })
    .sort((a, b) => CRITERIA.indexOf(a.criterion) - CRITERIA.indexOf(b.criterion));
  const { id: snapshotId, createdAt: scoredAt, ...fields } = row;
  const { status, fitScore, confidence, tier, icpVersion, scorerVersion, summary } = fields;
  const { disqualifiers } = fields;
  return {
    snapshotId,
    personId: fields.personId,
    status,
    fitScore,
    confidence,
    tier,
    icpVersion,
    scorerVersion,
    summary,
    disqualifiers,
    verdicts,
    scoredAt,
  };
}
