// A source's run (README.md "Runs", "Processing"; docs/flows.md), in Temporal's sandbox: ids in, the
// run's end out. Page by page: a read reserved, a refusal for the cap or the hours waiting on a timer
// until its retryAt, the open credits settled and the profiles read processed first; a block of
// credits reserved before the first read, and again whenever the next page could pass what the blocks
// pay for; the kind's reader, linkedin's activity called by name; the read settled; the page staged.
// It stops at a page that reaches the cut, at the last, or at a refused block. Then the processing:
// the cheap drops, a profile read per candidate left (reserved and settled as a page's), the profiles
// processed a chunk at a time, a profile the provider cannot read dropped as a gone one, and three in
// a row stopping the reading. Every end, a failure's and a cancellation's too, settles the open
// credits (the engagers read paid, the rest released) and empties the staging and the run's files.
// Only a done run, which read down to its cut, moves the watermark: one refused a block processes what
// it read and paid for, then ends `failed`, `insufficient_credits`, and the next run reads those pages
// again, its dedupe keys and hashes dropping what this one processed before any profile read. A
// cancellation releases a read reserved and not made and ends `cancelled`. A scheduled run makes its
// run id here, from the workflow's time and random, which a replay repeats.
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import type { EngagersPage, EngagersRefused, ProfileRead, ProfileRefused } from "@whytide/linkedin";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import {
  PROCESS_CHUNK,
  profileKeys,
  UNREADABLE,
  UNREADABLE_IN_ROW_MAX,
} from "../domain/process/keys.ts";
import type { activities, runInput } from "./index.ts";

type Reader<T> = (input: Record<string, unknown>) => Promise<T>;
export type RunResult = {
  readonly runId: string;
  readonly status: "gone" | "done" | "failed";
  readonly code?: string;
};

// A cancellation waits for the step under way, which runs to its end (none watches for it), so the
// run knows what it holds: a read or a block reserved, an answer read. Temporal's default does not.
const cancellationType = ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
const steps = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "1 minute",
  cancellationType,
});
const readers = proxyActivities<Record<string, Reader<unknown>>>({
  startToCloseTimeout: "2 minutes",
  cancellationType,
});
/** A refusal's retryAt already past asks again after this, not at once. */
const MIN_WAIT_MS = 1_000;
const DISCONNECTED = "linkedin_account_disconnected";
/** linkedin's profile read, the engager read's twin. */
const PROFILE_READER = "linkedin_read_profile";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function signals_run(input: z.output<typeof runInput>): Promise<RunResult> {
  const { workspaceId, sourceId } = input;
  const run = { workspaceId, sourceId, runId: input.runId ?? newRunId() };
  const started = await steps.signals_run_start(run);
  if (started.status === "gone") return { runId: run.runId, status: "gone" };
  let usage: { usageId: string; until: number } | undefined;
  let openRead: string | undefined;
  let newest: string | undefined;
  let read = 0;
  let billed = 0;
  let blocks = 0;
  /** Candidates whose profile was read, not processed yet. */
  const pending: string[] = [];
  /** The last step; it runs to its end in a cancelled run too. Only a done run moves the watermark. */
  const close = (status: "done" | "failed" | "cancelled", code?: string) => {
    const moved = status === "done" ? newest : undefined;
    const ending = { ...run, status, code, newest: moved, usageId: usage?.usageId, read, billed };
    return CancellationScope.nonCancellable(() => steps.signals_run_end(ending));
  };
  const end = async (status: "done" | "failed", code?: string): Promise<RunResult> => {
    await close(status, code);
    return { runId: run.runId, status, ...(code === undefined ? {} : { code }) };
  };
  /** The open block settled: the engagers read paid, the rest released. */
  const settleCredits = async () => {
    if (usage === undefined) return;
    const settled = { ...run, usageId: usage.usageId, read, billed };
    ({ billed } = await steps.signals_settle_credits(settled));
    usage = undefined;
  };
  /** The open read settled: made, whatever it answered, or released. */
  const settleRead = async (made: boolean) => {
    if (openRead === undefined) return;
    await steps.signals_settle_read({ ...run, reservationId: openRead, made });
    openRead = undefined;
  };
  /** The profiles read so far processed: before a wait, at a chunk's size and at the end. */
  const flush = async () => {
    if (pending.length === 0) return;
    await steps.signals_process_candidates({ ...run, candidateIds: pending.splice(0) });
  };
  /** A read reserved, through the waits; false when the account is not connected. */
  const reserveRead = async (
    accountId: string,
    kind: "read_engagers" | "read_profile",
  ): Promise<boolean> => {
    for (;;) {
      const reads = await steps.signals_reserve_read({ ...run, accountId, kind });
      if ("reservationId" in reads) {
        openRead = reads.reservationId;
        return true;
      }
      if (reads.retryAt === null) return false;
      await settleCredits();
      await flush();
      await sleep(Math.max(Date.parse(reads.retryAt) - Date.now(), MIN_WAIT_MS));
    }
  };

  try {
    if (started.status === "blocked") return await end("failed", DISCONNECTED);
    const start = started;
    const { accountId } = start;
    const reader = readers[start.reader] as Reader<EngagersPage | EngagersRefused>;
    const readProfile = readers[PROFILE_READER] as Reader<ProfileRead | ProfileRefused>;
    let cursor: string | undefined;
    /** A refused block: the pages read and paid for are processed, then the run fails with its code. */
    let unpaid: string | undefined;
    for (let page = 1; ; page++) {
      if (!(await reserveRead(accountId, "read_engagers")))
        return await end("failed", DISCONNECTED);
      if (usage === undefined || read + start.pageSize > usage.until) {
        await settleCredits();
        blocks += 1;
        const block = { ...run, attempt: blocks, quantity: start.quantity, billed };
        const credits = await steps.signals_reserve_credits(block);
        if ("refused" in credits) {
          await settleRead(false);
          unpaid = credits.refused;
          break;
        }
        usage = credits;
      }
      const rawKey = `raw/signals/${run.runId}/${page}.json`;
      const request = { ...start.readerInput, workspaceId, accountId, cursor };
      const answer = await reader({ ...request, limit: start.pageSize, rawKey });
      // Answered, the read was made: committed even when a cancellation came during it.
      await CancellationScope.nonCancellable(() => settleRead(true));
      if ("refused" in answer) {
        const gone = answer.refused === "linkedin_not_found";
        return await end("failed", gone ? "signal_post_not_found" : answer.refused);
      }
      read += answer.count;
      const { cutAt } = start;
      const staged = await steps.signals_stage_page({ ...run, page, key: answer.key, cutAt, read });
      if (staged.newest !== null && (newest === undefined || staged.newest > newest)) {
        newest = staged.newest;
      }
      if (staged.reachedCut || answer.nextCursor === null) break;
      cursor = answer.nextCursor;
    }
    // The reading is over: the engagers read paid, the rest of the block released.
    await settleCredits();
    const { candidateIds } = await steps.signals_select_candidates(run);
    /** Profiles in a row the provider could not read; any other answer resets it. */
    let unreadable = 0;
    for (const candidateId of candidateIds) {
      if (!(await reserveRead(accountId, "read_profile"))) {
        await flush();
        return await end("failed", DISCONNECTED);
      }
      const keys = profileKeys(run.runId, candidateId);
      const answer = await readProfile({ workspaceId, accountId, ...keys });
      await CancellationScope.nonCancellable(() => settleRead(true));
      if ("refused" in answer && answer.refused === DISCONNECTED) {
        await flush();
        return await end("failed", DISCONNECTED);
      }
      // A profile gone, or one the provider could not read, has no file: its processing drops it.
      pending.push(candidateId);
      // Replay: this branch adds commands only after the refusal linkedin_provider_error, which the
      // activity answers since fix-profile-skip, so no history recorded before it takes the branch.
      unreadable = "refused" in answer && answer.refused === UNREADABLE ? unreadable + 1 : 0;
      if (unreadable === UNREADABLE_IN_ROW_MAX) {
        await flush();
        return await end("failed", UNREADABLE);
      }
      if (pending.length === PROCESS_CHUNK) await flush();
    }
    await flush();
    return await (unpaid === undefined ? end("done") : end("failed", unpaid));
  } catch (error) {
    // A read whose activity failed, or that a cancellation left open, is released.
    await CancellationScope.nonCancellable(() => settleRead(false));
    if (!isCancellation(error)) return end("failed", codeOf(error));
    await close("cancelled");
    throw error;
  }
}

// The evidence reduction (README.md "Reduction"): the daily tick starts each workspace's, one at a
// time; a workspace's is one step, which reduces in batches, each its own tenant run, so a retry
// goes on from what the attempt before committed. Counts out.
const reductions = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "10 minutes",
});

export async function signals_evidence_reduction(input: {
  workspaceId: string;
}): Promise<{ reduced: number }> {
  return reductions.signals_reduce_evidence(input);
}

export async function signals_evidence_reduction_tick(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number }> {
  return steps.signals_start_reductions(input);
}

/** The failed activity's code, as the worker's wrapper gives it, else activity_failed. */
function codeOf(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : undefined;
  return cause instanceof ApplicationFailure && cause.type ? cause.type : "activity_failed";
}

/** `run_` and a ULID of the workflow's time and random (core/packages/platform "Ids"). */
function newRunId(): string {
  let time = Date.now();
  let ulid = "";
  for (let i = 0; i < 10; i++) {
    ulid = CROCKFORD.charAt(time % 32) + ulid;
    time = Math.floor(time / 32);
  }
  for (let i = 0; i < 16; i++) ulid += CROCKFORD.charAt(Math.floor(Math.random() * 32));
  return `run_${ulid}`;
}
