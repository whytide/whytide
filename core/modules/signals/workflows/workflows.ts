// A source's run (README.md "Runs", "Processing"; docs/flows.md), in Temporal's sandbox: ids in, the
// run's end out. Page by page: a read reserved, a refusal for the cap or the hours waiting on a timer
// until its retryAt, the profiles read processed first, a refusal no wait opens (a kill switch, no
// connection) ending it `failed` with its code; the kind's reader, linkedin's activity called
// by name; the read settled; the page staged. Pages cost no credits. It stops at a page that reaches
// the cut, or at the last. Then the processing: the cheap drops, then per candidate left its read
// reserved as a page's, a credit of signals.engager, the profile read, the read and the credit
// settled, the credit committed when the profile came and released otherwise; the profiles processed
// a chunk at a time, a profile the provider cannot read dropped as a gone one, and three in a row
// stopping the reading, as a read refused for its account (disconnected, paused, or held by its
// retry_at) does. A refused credit releases the candidate's read and stops the reading: the
// profiles read are processed, then the run ends `failed`, `insufficient_credits`, and the next run
// reads those pages again, its dedupe keys and hashes dropping what this one processed before any
// profile read. Only a done run, which read down to its cut, moves the watermark. Every end, a
// failure's and a cancellation's too, empties the staging and the run's files; a cancellation
// releases a read and a credit reserved and not settled and ends `cancelled`. A run started before
// beta-p1-090 (the patch ENGAGER_PRICE_PATCH, asked once at its start) keeps its old path: a block of
// signals.engager_read before the first read and whenever the next page could pass what the blocks
// pay for, settled before a wait and at every end, a refused block ending the reading. A scheduled
// run makes its run id here, from the workflow's time and random, which a replay repeats.
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  patched,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import type { EngagersPage, EngagersRefused, ProfileRead, ProfileRefused } from "@whytide/linkedin";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import { ENGAGER_PRICE_PATCH } from "../domain/constants.ts";
import {
  PROCESS_CHUNK,
  profileKeys,
  READING_ENDS,
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
  // Asked once, here: a run started before the patch replays without its marker and keeps the blocks
  // to its end, where a later ask, live once the replay is over, would turn the patch on mid-run.
  const perEngager = patched(ENGAGER_PRICE_PATCH);
  const started = await steps.signals_run_start(run);
  if (started.status === "gone") return { runId: run.runId, status: "gone" };
  let usage: { usageId: string; until: number } | undefined;
  let openRead: string | undefined;
  /** The candidate's credit reserved for the read under way. */
  let openCredit: string | undefined;
  /** Each candidate's credit reservations in the run: a released key is never reserved again. */
  const reservations = new Map<string, number>();
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
  /** The open credit settled: committed when the read returned the profile, else released. */
  const settleCredit = async (profiled: boolean) => {
    if (openCredit === undefined) return;
    await steps.signals_settle_engager_credit({ ...run, usageId: openCredit, read: profiled });
    openCredit = undefined;
  };
  /** A credit for the candidate's read, after its slot; the refusal's code when the balance is short. */
  const reserveCredit = async (candidateId: string): Promise<string | undefined> => {
    const n = (reservations.get(candidateId) ?? 0) + 1;
    reservations.set(candidateId, n);
    const credit = await steps.signals_reserve_engager_credit({ ...run, candidateId, n });
    if ("refused" in credit) return credit.refused;
    openCredit = credit.usageId;
    return undefined;
  };
  /** The profiles read so far processed: before a wait, at a chunk's size and at the end. */
  const flush = async () => {
    if (pending.length === 0) return;
    await steps.signals_process_candidates({ ...run, candidateIds: pending.splice(0) });
  };
  /**
   * A read reserved, through the waits: undefined; else the code of a refusal no wait opens, a kill
   * switch (platform_stopped, workspace_stopped, account_stopped) or linkedin_account_disconnected.
   */
  const reserveRead = async (
    accountId: string,
    kind: "read_engagers" | "read_profile",
  ): Promise<string | undefined> => {
    for (;;) {
      const reads = await steps.signals_reserve_read({ ...run, accountId, kind });
      if ("reservationId" in reads) {
        openRead = reads.reservationId;
        return undefined;
      }
      if (reads.retryAt === null) return reads.refused;
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
    /** A refused credit: what was read and paid for is processed, then the run fails with its code. */
    let unpaid: string | undefined;
    for (let page = 1; ; page++) {
      // Replay: the commands of before beta-p1-040; only the end's code is the refusal's now.
      const ending = await reserveRead(accountId, "read_engagers");
      if (ending !== undefined) return await end("failed", ending);
      if (!perEngager && (usage === undefined || read + start.pageSize > usage.until)) {
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
    // The reading is over: a run before the patch pays the engagers read and releases the rest.
    await settleCredits();
    const { candidateIds } = await steps.signals_select_candidates(run);
    /** Profiles in a row the provider could not read; any other answer resets it. */
    let unreadable = 0;
    for (const candidateId of candidateIds) {
      const ending = await reserveRead(accountId, "read_profile");
      if (ending !== undefined) {
        await flush();
        return await end("failed", ending);
      }
      // The credit after the slot, which may wait for the next quota day: a credit never sits
      // reserved through a wait. Refused, the slot goes back and the reading stops.
      const refused = perEngager ? await reserveCredit(candidateId) : undefined;
      if (refused !== undefined) {
        await settleRead(false);
        unpaid = refused;
        break;
      }
      const keys = profileKeys(run.runId, candidateId);
      const answer = await readProfile({ workspaceId, accountId, ...keys });
      await CancellationScope.nonCancellable(() => settleRead(true));
      await CancellationScope.nonCancellable(() => settleCredit(!("refused" in answer)));
      // Replay: account_paused and linkedin_rate_limited end it since beta-p6-020, and the three
      // stops since beta-p6-040, whose reads answer them before their call; no history recorded
      // before has any of these answers.
      if ("refused" in answer && READING_ENDS.includes(answer.refused)) {
        await flush();
        return await end("failed", answer.refused);
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
    // A read whose activity failed, or that a cancellation left open, is released, and its credit.
    await CancellationScope.nonCancellable(() => settleRead(false));
    await CancellationScope.nonCancellable(() => settleCredit(false));
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
