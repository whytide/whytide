// A member's verdict beside the model's (README "A member's verdict", lead-verdict-edit): a verdict
// row's effective verdict is the member's while one is set, else the model's, and the score, the
// decision and the why read the effective one. The model's verdict and evidence stay as the model
// wrote them; a row a member wrote alone has none. The re-score carries the members' verdicts to the
// snapshot that takes the lead (../rescore.ts). Each function runs in the caller's tenant run.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import type { Criterion, Verdict } from "../../schemas/assess-fit.ts";

/** A member's part of a verdict row. */
export type MemberPart = {
  readonly memberVerdict: Verdict;
  readonly memberNote: string | null;
  readonly memberSetBy: string;
  readonly memberSetAt: Date;
};
/** What these functions read of a verdict row; a stored row is one. */
export type VerdictRow = {
  readonly criterion: Criterion;
  readonly verdict: Verdict | null;
  readonly evidence: string;
  readonly memberVerdict: Verdict | null;
  readonly memberNote: string | null;
  readonly memberSetBy: string | null;
  readonly memberSetAt: Date | null;
};
/** A row's effective verdict, as the score and the why read it. */
export type EffectiveVerdict = {
  readonly criterion: Criterion;
  readonly verdict: Verdict;
  /** The model's quote; empty for a member's verdict, which quotes nothing of the profile. */
  readonly evidence: string;
  readonly byMember: boolean;
};

const NO_PART = { memberVerdict: null, memberNote: null, memberSetBy: null, memberSetAt: null };

/** The member's part of the row, or null without one. */
export function memberPartOf(row: VerdictRow): MemberPart | null {
  const { memberVerdict, memberNote, memberSetBy, memberSetAt } = row;
  if (memberVerdict === null || memberSetBy === null || memberSetAt === null) return null;
  return { memberVerdict, memberNote, memberSetBy, memberSetAt };
}

/** Each row's effective verdict: the member's when set, else the model's; a row with none is out. */
export function effectiveVerdicts(rows: readonly VerdictRow[]): EffectiveVerdict[] {
  return rows.flatMap((row): EffectiveVerdict[] => {
    const { criterion } = row;
    if (row.memberVerdict !== null) {
      return [{ criterion, verdict: row.memberVerdict, evidence: "", byMember: true }];
    }
    if (row.verdict === null) return [];
    return [{ criterion, verdict: row.verdict, evidence: row.evidence, byMember: false }];
  });
}

/** The snapshot's effective verdicts. */
export async function readVerdicts(snapshotId: string): Promise<{ verdicts: EffectiveVerdict[] }> {
  const rows = await tenantClient.criterionVerdict.findMany({ where: { snapshotId } });
  return { verdicts: effectiveVerdicts(rows) };
}

/**
 * The member's part of the snapshot's row for the criterion: set, replaced, or cleared with null. A
 * criterion without a row gets one that holds the member's verdict only; a row the member wrote
 * alone goes when cleared. False when a clear found nothing to clear.
 */
export async function writeMemberPart(
  snapshotId: string,
  criterion: Criterion,
  part: MemberPart | null,
): Promise<boolean> {
  const where = { snapshotId, criterion };
  const row = await tenantClient.criterionVerdict.findFirst({ where });
  if (part === null) {
    if (row === null || row.memberVerdict === null) return false;
    if (row.verdict === null) await tenantClient.criterionVerdict.deleteMany({ where });
    else await tenantClient.criterionVerdict.updateMany({ where, data: NO_PART });
    return true;
  }
  if (row !== null) {
    await tenantClient.criterionVerdict.updateMany({ where, data: part });
    return true;
  }
  const { workspaceId } = currentTenant();
  const id = newId(ids.criterion_verdict);
  await tenantClient.criterionVerdict.create({
    data: { id, workspaceId, snapshotId, criterion, verdict: null, evidence: "", ...part },
  });
  return true;
}

/**
 * The members' verdicts of `from`'s rows given to the snapshot `to`, for the criteria in `keep` (the
 * ICP's): each row of `to` takes `from`'s part for its criterion, or none, and a criterion with a
 * part but no row of `to` gets a row of the part alone. True when a row of `to` changed.
 */
export async function carryMemberParts(
  from: readonly VerdictRow[],
  to: string,
  keep: ReadonlySet<Criterion>,
): Promise<boolean> {
  const parts = new Map(
    from.flatMap((row) => {
      const part = keep.has(row.criterion) ? memberPartOf(row) : null;
      return part === null ? [] : [[row.criterion, part] as const];
    }),
  );
  const rows = await tenantClient.criterionVerdict.findMany({ where: { snapshotId: to } });
  let changed = false;
  for (const row of rows) {
    const part = parts.get(row.criterion) ?? null;
    parts.delete(row.criterion);
    if (samePart(memberPartOf(row), part)) continue;
    changed = (await writeMemberPart(to, row.criterion, part)) || changed;
  }
  for (const [criterion, part] of parts)
    changed = (await writeMemberPart(to, criterion, part)) || changed;
  return changed;
}

function samePart(a: MemberPart | null, b: MemberPart | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.memberVerdict === b.memberVerdict &&
    a.memberNote === b.memberNote &&
    a.memberSetBy === b.memberSetBy &&
    a.memberSetAt.getTime() === b.memberSetAt.getTime()
  );
}
