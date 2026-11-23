// getSnapshot, the read behind the lead page (README.md "Public interface", docs/flows.md "The lead
// page's read"): the lead's current snapshot as scoreSnapshot left it, a verdict per criterion of the
// closed list in its order, each effective one beside the model's and a member's (README "A member's
// verdict"; a criterion without a row has none), and the lead's intent row, or null without one
// (gamma-p5-065): the why-now
// signal with its date, each signal's share newest first. The snapshot's tier stays the fit's; the
// intent's is the lead's. The audience the lead was judged against, by name (gamma-p5-050). It runs
// in the caller's tenant run, the request's for the route, and opens none.
import { getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { findAudience } from "@whytide/icp";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import {
  CRITERIA,
  type Criterion,
  type Disqualifier,
  type Verdict,
} from "../../schemas/assess-fit.ts";
import { type ReadPart, readParts } from "../intent/store.ts";
import type { Confidence, ScoreStatus, Tier } from "./index.ts";
import { memberPartOf } from "./member.ts";

/** A member's verdict on a criterion: `mine` when the reader set it. */
export type SnapshotMember = {
  readonly verdict: Verdict;
  readonly note: string | null;
  /** The member's user id. */
  readonly setBy: string;
  readonly setAt: Date;
  readonly mine: boolean;
};
export type SnapshotVerdict = {
  readonly criterion: Criterion;
  /** The verdict that counts: the member's when set, else the model's; null when neither gave one. */
  readonly verdict: Verdict | null;
  /** The model's verdict; null when the model gave none (no row, or a member's row alone). */
  readonly modelVerdict: Verdict | null;
  /** The model's quote of the profile; empty when unknown. */
  readonly evidence: string;
  /** The criterion's weight in the fit and the verdict's points, 0 to 1; null until scored. */
  readonly weight: number | null;
  readonly points: number | null;
  readonly member: SnapshotMember | null;
};
/** One signal's share of the intent: its date is null in a row written before gamma-p5-065. */
export type IntentShare = Omit<ReadPart, "ownerUserId">;
/** The lead's intent row as the page reads it. */
export type SnapshotIntent = {
  readonly intentScore: number;
  readonly priority: number;
  /** The lead's tier from the priority; null for a not_qualified lead. */
  readonly tier: Tier | null;
  /** The strongest signal, which the why's why-now bullet names; null without one. */
  readonly whyNow: Pick<IntentShare, "kind" | "role" | "at"> | null;
  readonly boostUntil: Date | null;
  /** Each signal that counts, newest first, ties strongest first; an undated one last. */
  readonly breakdown: readonly IntentShare[];
  readonly scorerVersion: string;
  readonly computedAt: Date;
};
/** The audience a snapshot was assessed against: its name as icp keeps it, empty when unnamed. */
export type SnapshotAudience = {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
};
export type Snapshot = {
  readonly snapshotId: string;
  readonly personId: string;
  /**
   * The audience the lead was judged against; null when icp no longer holds it, or for a row that
   * names none (written before audiences in a workspace that had no default then).
   */
  readonly audience: SnapshotAudience | null;
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
  /** The lead's intent, priority and tier; null without a row (no reader, or no decision yet). */
  readonly intent: SnapshotIntent | null;
};

/**
 * The current snapshot of the person's lead, with its intent. qualification_input_invalid;
 * score_snapshot_not_found when the lead has none (pending, stopped by the hard filters, ai_failed),
 * a pending lead's kept snapshot included (README "A new assessment"); contacts' lead_not_found when
 * the person has no lead in the workspace, another workspace's person included.
 */
export async function getSnapshot(personId: string): Promise<Snapshot> {
  if (typeof personId !== "string" || personId.length === 0 || personId.length > 64) {
    throw new AppError(errors.qualification_input_invalid, { details: { fields: ["personId"] } });
  }
  const lead = await getLead(personId);
  const id = lead.qualificationStatus === "pending" ? null : lead.currentScoreSnapshotId;
  const row = id === null ? null : await tenantClient.scoreSnapshot.findFirst({ where: { id } });
  if (row === null) throw new AppError(errors.score_snapshot_not_found);
  const rows = await tenantClient.criterionVerdict.findMany({ where: { snapshotId: row.id } });
  const reader = currentTenant().principal.userId;
  const verdicts = CRITERIA.map((criterion): SnapshotVerdict => {
    const stored = rows.find((candidate) => candidate.criterion === criterion);
    if (stored === undefined) return { ...NO_VERDICT, criterion };
    const { verdict, evidence, weight, points } = stored;
    const part = memberPartOf(stored);
    const member = part && {
      verdict: part.memberVerdict,
      note: part.memberNote,
      setBy: part.memberSetBy,
      setAt: part.memberSetAt,
      mine: part.memberSetBy === reader,
    };
    const counted = member?.verdict ?? verdict;
    const scored = { weight, points: points === null ? null : +points };
    return { criterion, verdict: counted, modelVerdict: verdict, evidence, ...scored, member };
  });
  const { id: snapshotId, createdAt: scoredAt, ...fields } = row;
  const { status, fitScore, confidence, tier, icpVersion, scorerVersion, summary } = fields;
  const { disqualifiers } = fields;
  return {
    snapshotId,
    personId: fields.personId,
    audience: await audienceOf(fields.icpId),
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
    intent: await intentOf(fields.personId),
  };
}

/** The snapshot's audience by icp's findAudience, a read that writes nothing; null for none. */
async function audienceOf(icpId: string | null): Promise<SnapshotAudience | null> {
  const audience = icpId === null ? null : await findAudience(icpId);
  return audience && { id: audience.id, name: audience.name, isDefault: audience.isDefault };
}

/** A criterion the snapshot holds no row for: no verdict, the model's or a member's. */
const NO_VERDICT = {
  verdict: null,
  modelVerdict: null,
  evidence: "",
  weight: null,
  points: null,
  member: null,
} as const;

/** The person's intent row as the page reads it, or null: the members who own sources stay out. */
async function intentOf(personId: string): Promise<SnapshotIntent | null> {
  const row = await tenantClient.intentScore.findFirst({ where: { personId } });
  if (row === null) return null;
  const parts = readParts(row.intentBreakdown).map(({ eventId, kind, role, contribution, at }) => {
    return { eventId, kind, role, contribution, at };
  });
  const strongest = parts.find(({ eventId }) => eventId === row.whyNowEventId);
  const whyNow = strongest
    ? { kind: strongest.kind, role: strongest.role, at: strongest.at }
    : null;
  // Stored strongest first, which the stable sort keeps among the parts of one date.
  const breakdown = [...parts].sort((a, b) => timeOf(b) - timeOf(a));
  const { intentScore, priority, tier, boostUntil, scorerVersion, computedAt } = row;
  return { intentScore, priority, tier, whyNow, boostUntil, breakdown, scorerVersion, computedAt };
}

/** A share's time for the order: an undated one's is before any date. */
function timeOf({ at }: IntentShare): number {
  return at === null ? 0 : Date.parse(at);
}
