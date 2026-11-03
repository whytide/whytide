// qualification's workflows, run in Temporal's sandbox (README "The batch"): the batch of one
// workspace, lead by lead, each step an activity of its own (reserve, assess, then commit or
// release), and the global tick, which starts one batch per workspace; the re-score, page by page.
// Ids, the ICP version, codes and counts in and out.
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
} from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
// Cancelled, a workflow waits for the step under way, which settles or releases what it reserved;
// with no type the server would take TRY_CANCEL and leave the step running alone.
const cancellationType = ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
const steps = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", cancellationType });
// callAgent retries an invalid answer once, so two model calls fit in one attempt.
const { qualification_assess } = proxyActivities<Activities>({
  startToCloseTimeout: "3 minutes",
  cancellationType,
});

/**
 * Why a batch ended before its last lead: no credits, the provider down, the ICP moved, or a
 * reservation made again past its lease at once, which a sound clock never does.
 */
export type BatchStop =
  | "insufficient_credits"
  | "provider_failed"
  | "icp_version_stale"
  | "lease_expired";
/** What a batch did, counted. */
export type BatchResult = {
  readonly selected: number;
  readonly filtered: number;
  readonly scored: number;
  readonly failed: number;
  readonly stopped: BatchStop | null;
};

/** The model's provider failed the assessment past its attempts: one of the LLM port's codes. */
const providerFailed = (error: unknown) =>
  error instanceof ActivityFailure &&
  error.cause instanceof ApplicationFailure &&
  (error.cause.type ?? "").startsWith("llm_");

export async function qualification_batch(input: { workspaceId: string }): Promise<BatchResult> {
  const { workspaceId } = input;
  const { icpVersion, personIds, filtered } = await steps.qualification_filter_leads(input);
  const counts = { selected: personIds.length + filtered, filtered, scored: 0, failed: 0 };
  const stop = (stopped: BatchStop): BatchResult => ({ ...counts, stopped });
  for (const personId of personIds) {
    const lead = { workspaceId, personId, icpVersion };
    const reserved = await steps.qualification_reserve(lead);
    if (reserved.status === "insufficient_credits") return stop("insufficient_credits");
    const held = { ...lead, usageId: reserved.usageId, attempt: reserved.attempt };
    let assessed: Awaited<ReturnType<Activities["qualification_assess"]>>;
    try {
      assessed = await qualification_assess(lead);
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() => steps.qualification_release(held));
        throw error;
      }
      // Another code fails the batch and keeps the reservation, as a failed commit does. The
      // provider's, likely every lead's, ends the batch; a later one tries the lead again.
      if (!providerFailed(error)) throw error;
      await steps.qualification_release({ ...held, reason: "provider_failed" });
      counts.failed += 1;
      return stop("provider_failed");
    }
    if (assessed.status === "stale") {
      await steps.qualification_release(held);
      return stop("icp_version_stale");
    }
    if (assessed.status === "ai_failed") {
      await steps.qualification_release({ ...held, reason: assessed.reason });
      counts.failed += 1;
      continue;
    }
    // A failure here fails the batch and keeps the reservation open: the next batch reserves the
    // same key, finds the stored snapshot and commits it.
    const { snapshotId } = assessed;
    let committed = await steps.qualification_commit({ ...held, snapshotId });
    if (committed.status === "lease_expired") {
      // Released past its 24-hour lease: reserved again under the next attempt's key.
      const again = await steps.qualification_reserve(lead);
      if (again.status === "insufficient_credits") return stop("insufficient_credits");
      const next = { ...lead, usageId: again.usageId, attempt: again.attempt };
      committed = await steps.qualification_commit({ ...next, snapshotId });
    }
    if (committed.status === "stale") return stop("icp_version_stale");
    if (committed.status === "lease_expired") return stop("lease_expired");
    counts.scored += 1;
  }
  return { ...counts, stopped: null };
}

export async function qualification_batch_tick(input: Record<string, never>) {
  return steps.qualification_start_batches(input);
}

/** domain/rescore.ts's RESCORE_PAGE: the sandbox imports no domain code. */
const PAGE = 50;
/** What a re-score did, counted. */
export type RescoreResult = { readonly rescored: number; readonly skipped: number };

/** The named persons in pages of PAGE, or every scored lead page by page, each page one activity. */
export async function qualification_rescore(input: {
  workspaceId: string;
  personIds?: string[];
}): Promise<RescoreResult> {
  const { workspaceId, personIds } = input;
  const counts = { rescored: 0, skipped: 0 };
  const page = async (step: { personIds?: string[]; after?: string }) => {
    const done = await steps.qualification_rescore_page({ workspaceId, ...step });
    counts.rescored += done.rescored;
    counts.skipped += done.skipped;
    return done.next;
  };
  if (personIds !== undefined) {
    for (let at = 0; at < personIds.length; at += PAGE) {
      await page({ personIds: personIds.slice(at, at + PAGE) });
    }
    return counts;
  }
  let after = await page({});
  while (after !== null) after = await page({ after });
  return counts;
}
