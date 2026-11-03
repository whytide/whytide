// The evidence reduction (README.md "Reduction"; security §2; RB-4.4.3): an evidence row captured
// longer ago than its kind's lookback keeps its post's URL, its author, its reaction and its
// captured_at, and loses its excerpt and comment; reduced_at is set. No summary is stored: the lead
// page words the line from signals.evidence.reduced with the reaction and the date (decisions.md,
// 2026-10-27). A batch of REDUCE_BATCH rows per tenant run, the daily workflow's and the command's
// alike; the daily tick starts one reduction per workspace, one at a time.
import { tenantClient } from "@whytide/db";
import { startWorkflow, type WorkflowStart } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { registeredSourceKinds } from "../../sources/registry.ts";

/** The rows one tenant run reads at most. */
export const REDUCE_BATCH = 500;
const DAY_MS = 86_400_000;

/** One tenant run of the workspace: the activity's `context.tenant`, or the command's own. */
export type TenantRun = <T>(fn: () => Promise<T>) => Promise<T>;
/** When each event kind's evidence is due, from reductionCuts. */
export type ReductionCuts = {
  /** The latest cut: no row captured at it or after it is due. */
  readonly latest: Date;
  cutOf(eventKind: string): Date;
};

/**
 * An event kind's evidence is due once captured before `now` less its kind's lookback. Two kinds of
 * one event kind take the shorter lookback; an event kind no kind declares (its folder removed) the
 * shortest of all. Null without any kind.
 */
export function reductionCuts(
  kinds: Iterable<{ readonly lookbackDays: number; readonly event: { readonly kind: string } }>,
  now: Date,
): ReductionCuts | null {
  const days = new Map<string, number>();
  for (const { lookbackDays, event } of kinds) {
    days.set(event.kind, Math.min(lookbackDays, days.get(event.kind) ?? lookbackDays));
  }
  if (days.size === 0) return null;
  const shortest = Math.min(...days.values());
  const cut = (lookback: number) => new Date(now.getTime() - lookback * DAY_MS);
  return { latest: cut(shortest), cutOf: (eventKind) => cut(days.get(eventKind) ?? shortest) };
}

/**
 * One batch, in the caller's tenant run: of the next REDUCE_BATCH rows by id after `after`, not
 * reduced and captured before the latest cut, those past their event kind's cut are reduced. The
 * count, and the last id read when the batch was full. captured_at is never written.
 */
export async function reduceBatch(
  cuts: ReductionCuts,
  now: Date,
  after?: string,
): Promise<{ reduced: number; last: string | null }> {
  const rows = await tenantClient.evidence.findMany({
    where: {
      reducedAt: null,
      capturedAt: { lt: cuts.latest },
      ...(after === undefined ? {} : { id: { gt: after } }),
    },
    select: { id: true, eventId: true, capturedAt: true },
    orderBy: { id: "asc" },
    take: REDUCE_BATCH,
  });
  if (rows.length === 0) return { reduced: 0, last: null };
  // Two reads: the tenant guard refuses a relation in a query's arguments.
  const events = await tenantClient.signalEvent.findMany({
    where: { id: { in: rows.map((row) => row.eventId) } },
    select: { id: true, kind: true },
  });
  const kinds = new Map(events.map((event) => [event.id, event.kind]));
  const due = rows.filter((row) => {
    const cut = cuts.cutOf(kinds.get(row.eventId) ?? "");
    return row.capturedAt.getTime() < cut.getTime();
  });
  const { count } = await tenantClient.evidence.updateMany({
    where: { id: { in: due.map((row) => row.id) }, reducedAt: null },
    data: { excerpt: null, commentText: null, reducedAt: now },
  });
  return { reduced: count, last: rows.length === REDUCE_BATCH ? (rows.at(-1)?.id ?? null) : null };
}

/** Every row of the workspace past its kind's lookback reduced, a batch per run of `run`; the count. */
export async function reduceEvidence(run: TenantRun, now = new Date()): Promise<number> {
  const cuts = reductionCuts(registeredSourceKinds().values(), now);
  if (cuts === null) return 0;
  let reduced = 0;
  let after: string | undefined;
  do {
    const from = after;
    const batch = await run(() => reduceBatch(cuts, now, from));
    reduced += batch.reduced;
    after = batch.last ?? undefined;
  } while (after !== undefined);
  return reduced;
}

/** The start of the workspace's reduction: one run at a time, by its fixed id. */
export function reductionStart(workspaceId: string): WorkflowStart {
  return {
    workflow: "signals_evidence_reduction",
    input: { workspaceId },
    workflowId: `signals.evidence_reduction:${workspaceId}:current`,
    oneAtATime: true,
  };
}

/**
 * The daily tick's step: every workspace's reduction started, unless one runs. One that fails leaves
 * the others started, and the tick then fails with its code. The counts only.
 */
export async function startReductions(): Promise<{ workspaces: number; started: number }> {
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(reductionStart(workspaceId))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}
