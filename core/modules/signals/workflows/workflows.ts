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
// pay for, settled before a wait and at every end, a refused block ending the reading. A posts kind's
// run (the patch POSTS_READER_PATCH, gamma-p5-020) reads its posts first, a page at a time, each a
// read reserved and settled, its request file written and its authors staged by steps of their own;
// then post by post, newest first, the post's engagers down to its cut; a post gone since is skipped,
// and a done run's watermark is each post's newest. Under that patch, a read that fails past its
// attempts has the profiles read before it processed first. At the end of the reading, the source's
// oldest unrated events are rated, a batch at a time (the patch RATE_ENGAGEMENT_PATCH, gamma-p5-030):
// a batch failing past its attempts leaves the rest unrated, and the run goes on. A run started since
// gamma-p5-040 (the patch READ_BUDGET_PATCH, asked once at its start) reads within the budget its
// first step gives it, each read reserved with the send path's reads kept; a read refused for its
// budget, the cap or the 200 ends its day of reading: the profiles read are processed and it ends
// done, `budget_reached`, its watermark kept, so that the next day's run reads on from the same cut;
// outside the hours it still waits. Its page reads, posts' and engagers' together, take half its
// budget at most: there the paging stops as at a budget's end, and its candidates are selected and
// their profiles read with the rest. A run started since signals-triage-ai (the patch
// HEADLINE_TRIAGE_PATCH, asked once at its start) has its candidates triaged by their headline before
// the first profile read, TRIAGE_BATCH_SIZE at a time, and reads them in the triage's order: a batch
// failing past its attempts is decided by the rules, as a run before the patch decides them all,
// and the run reads on. A run of a source in an agent filters by that agent's audience: its first step
// names the agent, whose id alone the steps that select, triage and process carry (gamma-p5-045); a
// run started before carries none and keeps the default audience. A scheduled run makes its run id
// here, from the workflow's time and random, which a replay repeats. The daily runs' tick is one
// global step.
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
import type {
  EngagersPage,
  EngagersRefused,
  PostsRead,
  PostsRefused,
  ProfileRead,
  ProfileRefused,
} from "@whytide/linkedin";
import type { ActivityFunctions } from "@whytide/platform";
import type { z } from "zod";
import {
  DAY_READING_ENDS,
  ENGAGER_PRICE_PATCH,
  HEADLINE_TRIAGE_PATCH,
  INSUFFICIENT_CREDITS,
  POSTS_READER_PATCH,
  RATE_BATCH_SIZE,
  RATE_ENGAGEMENT_PATCH,
  READ_BUDGET_PATCH,
  RESEARCH_CANDIDATES_PATCH,
  RESEARCH_JUDGE_PATCH,
  RESEARCH_MANAGERS_PATCH,
  RESEARCH_NO_COUNTRY,
  RESEARCH_PAGES_PATCH,
  RESEARCH_PEOPLE_PATCH,
  RESEARCH_PLAN_PATCH,
  RESEARCH_PRICE_PATCH,
  RESEARCH_SEARCH_PATCH,
  RESEARCH_SEARCH_UNAVAILABLE,
  TRIAGE_BATCH_SIZE,
} from "../domain/constants.ts";
import {
  engagersKey,
  PROCESS_CHUNK,
  postsKeys,
  profileKeys,
  READING_ENDS,
  UNREADABLE,
  UNREADABLE_IN_ROW_MAX,
} from "../domain/process/keys.ts";
import type { PostMarks } from "../domain/runs.ts";
import { pageLimitOf } from "../domain/schedule/share.ts";
import type { activities, researchRunInput, runInput } from "./index.ts";

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
/** The rating's and the triage's model calls, as long as qualification's assessment may take. */
const raters = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "3 minutes",
  cancellationType,
});
/**
 * A research run's plan step since gamma-wr-041: the model's own retries (one for its answer, the
 * activity's three attempts) take minutes, so its timeout is 10 minutes, not the raters' 3.
 */
const planners = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "10 minutes",
  cancellationType,
});
/** A research run's search of one query: the counted search and a file, a minute or two. */
const searchers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "2 minutes",
  cancellationType,
});
/** A research run's pick among a search's results: the model's own retries, as the plan's. */
const pickers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "5 minutes",
  cancellationType,
});
/** A research run's read of one page: robots.txt, the page, the browser's try and a file, up to a few minutes. */
const pagers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "3 minutes",
  cancellationType,
});
/**
 * A research run's reading of one page's companies and the candidates made of them: the model's own
 * retries, then a search by name for each company with no link.
 */
const namers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "5 minutes",
  cancellationType,
});
/**
 * A research run's judgment of one company (gamma-wr-050): the model's own retries, then the company kept.
 */
const judges = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "5 minutes",
  cancellationType,
});
/**
 * A research run's people of one company (gamma-wr-060): the pages, then the model twice with its own
 * retries, then the leads, so as long as the plan step.
 */
const takers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "10 minutes",
  cancellationType,
});
/**
 * The people step of a run with the patch RESEARCH_MANAGERS_PATCH (gamma-wr-090): the same step and one
 * search for the managers, their reading and a second pick, so 20 minutes.
 */
const managers = proxyActivities<ActivityFunctions<typeof activities>>({
  startToCloseTimeout: "20 minutes",
  cancellationType,
});
/** A refusal's retryAt already past asks again after this, not at once. */
const MIN_WAIT_MS = 1_000;
const DISCONNECTED = "linkedin_account_disconnected";
/** linkedin's profile read, the engager read's twin. */
const PROFILE_READER = "linkedin_read_profile";
/** linkedin's posts read, a posts kind's first read. */
const POSTS_READER = "linkedin_read_posts";
/** The engager read's refusal of a post gone since its posts were read: the post is skipped. */
const POST_GONE = "linkedin_not_found";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function signals_run(input: z.output<typeof runInput>): Promise<RunResult> {
  const { workspaceId, sourceId } = input;
  const run = { workspaceId, sourceId, runId: input.runId ?? newRunId() };
  // Asked once, here: a run started before the patch replays without its marker and keeps the blocks
  // to its end, where a later ask, live once the replay is over, would turn the patch on mid-run.
  const perEngager = patched(ENGAGER_PRICE_PATCH);
  const postsReader = patched(POSTS_READER_PATCH);
  const rateEngagement = patched(RATE_ENGAGEMENT_PATCH);
  const budgeted = patched(READ_BUDGET_PATCH);
  const triaged = patched(HEADLINE_TRIAGE_PATCH);
  const started = await steps.signals_run_start(run);
  if (started.status === "gone") return { runId: run.runId, status: "gone" };
  /** The run as the steps that read its audience name it: with its agent, when its start named one. */
  const playbookId = started.status === "started" ? started.playbookId : undefined;
  const scored = playbookId === undefined ? run : { ...run, playbookId };
  /** The reads the run may make; none before READ_BUDGET_PATCH. */
  const readBudget = budgeted && started.status === "started" ? started.readBudget : undefined;
  /** The reads the run made, against its budget. */
  let used = 0;
  /** Its budget, the cap or the 200 ended its day of reading. */
  let budgetReached = false;
  /** The page reads it may make, posts' and engagers' together; none before READ_BUDGET_PATCH. */
  const pageLimit = readBudget === undefined ? undefined : pageLimitOf(readBudget);
  /** Its page reads reached `pageLimit`: the paging stopped, its profiles read with the rest. */
  let pagesLimited = false;
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
  /** A posts kind's posts read to their cuts and each one's newest staged. */
  const marks: { postUrl: string; newest?: string }[] = [];
  let postsRead = false;
  /**
   * The last step; it runs to its end in a cancelled run too. Only a done run moves the watermark, and
   * not one its budget or its page limit ended: the next day's run reads on from the same cut.
   */
  const close = (status: "done" | "failed" | "cancelled", code?: string) => {
    const ended = budgetReached || pagesLimited;
    const moves = status === "done" && !ended;
    const moved = moves ? newest : undefined;
    const posts: { posts?: PostMarks } = moves && postsRead ? { posts: marks } : {};
    const reached = ended ? { budgetReached: true as const } : {};
    const ending = { ...run, status, code, newest: moved, ...posts, ...reached };
    return CancellationScope.nonCancellable(() =>
      steps.signals_run_end({ ...ending, usageId: usage?.usageId, read, billed }),
    );
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
    if (made) used += 1;
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
  /** The source's oldest unrated events rated; a batch failing past its attempts stops the rating. */
  const rate = async () => {
    const { eventIds } = await steps.signals_select_ratings(run);
    if (eventIds.length === 0) return;
    try {
      for (let at = 0; at < eventIds.length; at += RATE_BATCH_SIZE) {
        const batch = eventIds.slice(at, at + RATE_BATCH_SIZE);
        await raters.signals_rate_events({ ...run, eventIds: batch });
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
    }
    await steps.signals_count_ratings({ ...run, eventIds });
  };
  /**
   * The candidates triaged a batch at a time, in the read order: authors and commenters, then the
   * reactors read first, then the rest, staged order within each; a batch failing past its attempts
   * is decided by the rules, and the run reads on.
   */
  const triage = async (selected: readonly string[]): Promise<string[]> => {
    const ranks: string[][] = [[], [], []];
    for (let at = 0; at < selected.length; at += TRIAGE_BATCH_SIZE) {
      const batch = { ...scored, candidateIds: selected.slice(at, at + TRIAGE_BATCH_SIZE) };
      const decided = await raters.signals_triage_candidates(batch).catch((error: unknown) => {
        if (isCancellation(error)) throw error;
        return steps.signals_triage_fallback(batch);
      });
      for (const [rank, ids] of decided.ranks.entries()) ranks[rank]?.push(...ids);
    }
    return ranks.flat();
  };
  /** The profiles read so far processed: before a wait, at a chunk's size and at the end. */
  const flush = async () => {
    if (pending.length === 0) return;
    await steps.signals_process_candidates({ ...scored, candidateIds: pending.splice(0) });
  };
  /**
   * The page limit reached, asked before each page read: `pagesLimited` set. The pages come before
   * any profile, so every read made by then is a page's.
   */
  const pagesFull = () => {
    if (pageLimit !== undefined && used >= pageLimit) pagesLimited = true;
    return pagesLimited;
  };
  /**
   * A read reserved, through the waits: undefined; else the code of a refusal no wait opens, a kill
   * switch (platform_stopped, workspace_stopped, account_stopped) or linkedin_account_disconnected,
   * or, for a budgeted run, one that ends its day of reading (DAY_READING_ENDS), `budgetReached` set.
   */
  const reserveRead = async (
    accountId: string,
    kind: "read_engagers" | "read_profile" | "read_posts",
  ): Promise<string | undefined> => {
    for (;;) {
      const budget = readBudget === undefined ? {} : { budget: { readBudget, used } };
      const reads = await steps.signals_reserve_read({ ...run, accountId, kind, ...budget });
      if ("reservationId" in reads) {
        openRead = reads.reservationId;
        return undefined;
      }
      if (readBudget !== undefined && DAY_READING_ENDS.includes(reads.refused)) {
        budgetReached = true;
        return reads.refused;
      }
      if (reads.retryAt === null) return reads.refused;
      await settleCredits();
      await flush();
      await sleep(Math.max(Date.parse(reads.retryAt) - Date.now(), MIN_WAIT_MS));
    }
  };

  /**
   * A posts kind's reading: the posts from the lookback's start, `cutAt`, newest first, a page at a
   * time, then each post's engagers down to its cut; undefined, else the code it ends on.
   */
  const readPosts = async (
    accountId: string,
    cutAt: string,
    readEngagers: Reader<EngagersPage | EngagersRefused>,
    limit: number,
  ): Promise<string | undefined> => {
    const readPage = readers[POSTS_READER] as Reader<PostsRead | PostsRefused>;
    const posts: { postUrl: string; cutAt: string; postsKey: string }[] = [];
    let engagers = false;
    for (let page = 1; ; page++) {
      if (pagesFull()) return undefined;
      const { gone } = await steps.signals_posts_request({ ...run, page, cutAt });
      if (gone) break;
      const ending = await reserveRead(accountId, "read_posts");
      if (ending !== undefined) return ending;
      const answer = await readPage({ workspaceId, accountId, ...postsKeys(run.runId, page) });
      await CancellationScope.nonCancellable(() => settleRead(true));
      if ("refused" in answer) return answer.refused;
      const staged = await steps.signals_stage_posts({ ...run, page, key: answer.key, cutAt });
      engagers = staged.engagers;
      for (const post of staged.posts) {
        if (!posts.some(({ postUrl }) => postUrl === post.postUrl)) {
          posts.push({ ...post, postsKey: answer.key });
        }
      }
      if (!answer.more) break;
    }
    let pages = 0;
    for (const [n, post] of posts.entries()) {
      const { postUrl, postsKey } = post;
      let cursor: string | undefined;
      let latest: string | undefined;
      let gone = false;
      for (let page = 1; engagers; page++) {
        if (pagesFull()) return undefined;
        const ending = await reserveRead(accountId, "read_engagers");
        if (ending !== undefined) return ending;
        const rawKey = engagersKey(run.runId, n + 1, page);
        const answer = await readEngagers({
          workspaceId,
          accountId,
          postUrl,
          cursor,
          limit,
          rawKey,
        });
        await CancellationScope.nonCancellable(() => settleRead(true));
        gone = "refused" in answer && answer.refused === POST_GONE;
        if (gone) break;
        if ("refused" in answer) return answer.refused;
        read += answer.count;
        pages += 1;
        const at = {
          page: pages,
          key: answer.key,
          cutAt: post.cutAt,
          read,
          post: { postUrl, postsKey },
        };
        const staged = await steps.signals_stage_page({ ...run, ...at });
        if (staged.newest !== null && (latest === undefined || staged.newest > latest)) {
          latest = staged.newest;
        }
        if (staged.reachedCut || answer.nextCursor === null) break;
        cursor = answer.nextCursor;
      }
      if (!gone) marks.push({ postUrl, ...(latest === undefined ? {} : { newest: latest }) });
    }
    postsRead = true;
    return undefined;
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
    if (postsReader && start.posts) {
      const ending = await readPosts(accountId, start.cutAt, reader, start.pageSize);
      if (ending !== undefined && !budgetReached) return await end("failed", ending);
    }
    for (let page = 1; !(postsReader && start.posts); page++) {
      if (pagesFull()) break;
      // Replay: the commands of before beta-p1-040; only the end's code is the refusal's now.
      const ending = await reserveRead(accountId, "read_engagers");
      if (budgetReached) break;
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
    // A day of reading ended among the pages leaves no read for a profile: nothing is selected. The
    // page limit leaves the rest of the budget: the candidates staged are selected and read.
    const select = triaged ? { ...scored, triage: true as const } : scored;
    const { candidateIds: selected } = budgetReached
      ? { candidateIds: [] as string[] }
      : await steps.signals_select_candidates(select);
    const candidateIds = triaged ? await triage(selected) : selected;
    /** Profiles in a row the provider could not read; any other answer resets it. */
    let unreadable = 0;
    for (const candidateId of candidateIds) {
      const ending = await reserveRead(accountId, "read_profile");
      if (budgetReached) break;
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
    if (rateEngagement) await rate();
    return await (unpaid === undefined ? end("done") : end("failed", unpaid));
  } catch (error) {
    // A read whose activity failed, or that a cancellation left open, is released, and its credit.
    await CancellationScope.nonCancellable(() => settleRead(false));
    await CancellationScope.nonCancellable(() => settleCredit(false));
    if (!isCancellation(error)) {
      let failure = error;
      // Since POSTS_READER_PATCH, the profiles read before a read failed past its attempts are
      // processed first; a processing that fails too ends the run with its own code.
      if (postsReader) {
        try {
          await CancellationScope.nonCancellable(flush);
        } catch (processing) {
          failure = processing;
        }
      }
      return end("failed", codeOf(failure));
    }
    await close("cancelled");
    throw error;
  }
}

// A research source's run (README.md "Runs"; gamma-wr-030, gamma-wr-040), the frame of the kind
// web_research: no account, quota day or read budget, so none of signals_run's patches. Its first step
// starts the run and counts the countries of its audience, its agent's else the workspace's default; a
// paused agent's run, a stop asked before the start and a source gone end there, as signals_run's do.
// An audience with no country ends the run `failed`, `research_no_country`. Since gamma-wr-040 (the
// patch RESEARCH_PLAN_PATCH, asked once at its start) its second step plans the run (domain/research/):
// the trade's words, the source types and the queries, written by the model outside any run and kept in
// tables, the step answering counts; a plan that could not be written ends the run `failed`,
// `research_plan_failed`; a run started before the patch ends `done` after its start, as before. Since
// gamma-wr-041 (the patch RESEARCH_SEARCH_PATCH, also asked once at the start) the plan step gets a
// longer timeout and the run then searches the plan's queries, one step each in the plan's order
// (signals_research_search): at the searches' limit (`counts.budget_reached`) or with every adapter
// spent (`counts.adapters_spent`) it ends `done`; with no search adapter loaded it ends `failed`,
// `research_search_unavailable`; a query refused or failed is counted and the run goes on. Since
// gamma-wr-045 (the patch RESEARCH_PAGES_PATCH, asked once at the start) the run then picks, for each
// search, the results worth reading (signals_research_pick), lines the pages up (signals_research_queue:
// the start pages, then the picks) and reads them one a step (signals_research_page) until
// SIGNALS_RESEARCH_PAGES_PER_RUN, where it ends `done` with `counts.budget_reached`; a run started
// before ends `done` after its searches. Since gamma-wr-046 (the patch RESEARCH_CANDIDATES_PATCH) the
// run then re-checks the candidates its earlier runs left (signals_research_carry) and, for each page
// read, says what the page is and which companies it names (signals_research_read) and makes their
// candidates (signals_research_candidates): a search by name for a company with no link, the drops,
// the rows; a run started before ends `done` after its pages. Since gamma-wr-050 (the patch
// RESEARCH_JUDGE_PATCH) the run then lines up the pending candidates (signals_research_judge_queue), reads
// each one's own site (signals_research_site) and judges it (signals_research_judge) until
// SIGNALS_RESEARCH_COMPANIES_PER_RUN companies are judged, where it ends `done` with
// `counts.budget_reached`; a site that cannot be read drops its candidate and costs no place; a run
// started before ends `done` after its candidates. Since gamma-wr-051 (RESEARCH_PRICE_PATCH) each company's site step reserves its credit and a refusal
// ends the run `failed`, `insufficient_credits`; the judge step commits it, and the last step releases one left open.
// Since gamma-wr-060 (RESEARCH_PEOPLE_PATCH) the run then lines up the found companies judged `fit` whose people were not taken
// (signals_research_people_queue) and takes each one's people in one step (signals_research_people:
// the read, the gates, the pick on roles alone and the making of the leads, all in memory, the step
// answering a status and a count); a run started before ends `done` after its judgments. Since gamma-wr-090 (the patch
// RESEARCH_MANAGERS_PATCH, asked once at the start) that step has 20 minutes, not 10, for the search of a
// company's managers it may add. A cancellation ends the run `cancelled` through the last step, outside the cancellation, and the
// workflow ends cancelled. The history holds ids, counts and codes only, never a word or a query.
export async function signals_research_run(
  input: z.output<typeof researchRunInput>,
): Promise<RunResult> {
  const { workspaceId, sourceId, runId } = input;
  const run = { workspaceId, sourceId, runId };
  // Asked once, here: a run started before the patch replays without its marker and ends after its start.
  const planned = patched(RESEARCH_PLAN_PATCH);
  const searched = patched(RESEARCH_SEARCH_PATCH);
  const paged = patched(RESEARCH_PAGES_PATCH);
  const named = patched(RESEARCH_CANDIDATES_PATCH);
  const judging = patched(RESEARCH_JUDGE_PATCH);
  const priced = patched(RESEARCH_PRICE_PATCH);
  // The queue place of a company whose site was read and whose verdict is not in: its credit is open.
  let open: number | undefined;
  const peopling = patched(RESEARCH_PEOPLE_PATCH);
  const managing = patched(RESEARCH_MANAGERS_PATCH);
  const close = (status: "done" | "failed" | "cancelled", code?: string) =>
    CancellationScope.nonCancellable(() =>
      steps.signals_research_end({ ...run, status, code, openCompany: open }),
    );
  const end = async (status: "done" | "failed", code?: string): Promise<RunResult> => {
    await close(status, code);
    return { runId, status, ...(code === undefined ? {} : { code }) };
  };
  try {
    const started = await steps.signals_research_start(run);
    if (started.status === "gone") return { runId, status: "gone" };
    if (started.countries === 0) return await end("failed", RESEARCH_NO_COUNTRY);
    // A run started before the patch ends here, as gamma-wr-030's did.
    if (!planned) return await end("done");
    const { playbookId } = started;
    const planStep = playbookId === undefined ? run : { ...run, playbookId };
    const plan = await (searched ? planners : raters).signals_research_plan(planStep);
    if (plan.status === "gone") return { runId, status: "gone" };
    if (plan.status === "failed") return await end("failed", plan.code);
    if (!searched) return await end("done");
    // The plan's queries are written in order from position 1; each step asks one.
    for (let position = 1; position <= plan.queries; position += 1) {
      const { status } = await searchers.signals_research_search({ ...run, position });
      if (status === "gone") return { runId, status: "gone" };
      if (status === "unavailable") return await end("failed", RESEARCH_SEARCH_UNAVAILABLE);
      if (status === "budget" || status === "spent") break;
    }
    // A run started before the patch ends here, as gamma-wr-041's did.
    if (!paged) return await end("done");
    for (let position = 1; position <= plan.queries; position += 1) {
      const { status } = await pickers.signals_research_pick({ ...run, position });
      if (status === "gone") return { runId, status: "gone" };
    }
    const queue = await steps.signals_research_queue({ ...run, searches: plan.queries });
    if (queue.status === "gone") return { runId, status: "gone" };
    // The pages are read in the queue's order; the activity ends the reading at the limit.
    let read = 0;
    const readIndexes: number[] = [];
    for (let index = 1; index <= queue.pages; index += 1) {
      const { status } = await pagers.signals_research_page({ ...run, index, read });
      if (status === "read") {
        read += 1;
        readIndexes.push(index);
      }
      if (status === "budget") break;
    }
    // A run started before the patch ends here, as gamma-wr-045's did.
    if (!named) return await end("done");
    // The candidates the source's earlier runs left come first, then the run's own, a page at a time.
    await steps.signals_research_carry(run);
    for (const index of readIndexes) {
      const found = await namers.signals_research_read({ ...run, index });
      if (found.status === "gone") return { runId, status: "gone" };
      if (found.status === "read") await namers.signals_research_candidates({ ...run, index });
    }
    // A run started before the patch ends here, as gamma-wr-046's did.
    if (!judging) return await end("done");
    // The pending candidates are judged in the queue's order; the site step ends the run's judging at the limit.
    const queued = await steps.signals_research_judge_queue(run);
    if (queued.status === "gone") return { runId, status: "gone" };
    let judged = 0;
    for (let index = 1; index <= queued.companies; index += 1) {
      const site = await pagers.signals_research_site({ ...run, index, judged, priced });
      if (site.status === "gone") return { runId, status: "gone" };
      if (site.status === "budget") break;
      // A refused credit ends the run, the companies judged before it kept.
      if (site.status === "refused") return await end("failed", INSUFFICIENT_CREDITS);
      if (site.status !== "read") continue;
      if (priced) open = index;
      const verdict = await judges.signals_research_judge({ ...planStep, index });
      open = undefined;
      if (verdict.status === "gone") return { runId, status: "gone" };
      if (verdict.status === "judged") judged += 1;
    }
    // A run started before the patch ends here, as gamma-wr-050's did.
    if (!peopling) return await end("done");
    // The people of each company judged `fit`, and not taken before, one step each, in the queue's order.
    const lined = await steps.signals_research_people_queue(run);
    if (lined.status === "gone") return { runId, status: "gone" };
    for (let index = 1; index <= lined.companies; index += 1) {
      const taking = managing ? managers : takers;
      const taken = await taking.signals_research_people({ ...planStep, index });
      if (taken.status === "gone") return { runId, status: "gone" };
    }
    return await end("done");
  } catch (error) {
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

// The daily runs' tick (README.md "Runs"; gamma-p5-040): one global step, which starts in each
// workspace's own run a run of every source due. Its history holds counts only.
export async function signals_daily_runs_tick(
  input: Record<string, never>,
): Promise<{ workspaces: number; started: number }> {
  return steps.signals_start_daily_runs(input);
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
