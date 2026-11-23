// What the worker host loads of signals (core/apps/worker/docs/workflows.md; README.md "Runs",
// "Processing", "Triage", "Reduction"): the run workflow and its steps, each in its own tenant run,
// none around a provider's read, which is linkedin's activity, called by name: the kind's reader, and
// the profile read; none around a model call either, the triage's and the rating's; the evidence
// reduction, its daily tick and the tick's schedule; the daily runs' tick, every
// DAILY_RUNS_TICK_MINUTES, and its step (gamma-p5-040). Inputs carry ids only: the steps that filter
// by the run's audience get the id of the agent the start found, never the audience (gamma-p5-045).
// A source's schedule is its own, made by events.ts, not one of `schedules`.
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  isAppError,
  workflowInput,
} from "@whytide/platform";
import { z } from "zod";
import { RATE_BATCH_SIZE, TRIAGE_BATCH_SIZE } from "../domain/constants.ts";
import { PROCESS_CHUNK, postsKeys } from "../domain/process/keys.ts";
import { processCandidates, readProfiles } from "../domain/process/process.ts";
import { ownCompanyName, selectCandidates, writeRequests } from "../domain/process/select.ts";
import { countRatings, rateEvents, selectRatings } from "../domain/rate/rate.ts";
import { reduceEvidence, startReductions } from "../domain/reduce/reduce.ts";
import "../domain/register-checker.ts";
import "../domain/register-reader.ts";
import { carryCandidates, makeCandidates } from "../domain/research/candidates.ts";
import { judgeCompany } from "../domain/research/judge.ts";
import {
  queueCompanies,
  readCandidateSite,
  releaseOpenCompany,
} from "../domain/research/judge-site.ts";
import { readQueuedPage } from "../domain/research/page.ts";
import { queuePeople, takePeople } from "../domain/research/people.ts";
import { pickResearchResults } from "../domain/research/pick.ts";
import { planResearchRun } from "../domain/research/plan.ts";
import { queueResearchPages } from "../domain/research/queue.ts";
import { readPageCompanies } from "../domain/research/read.ts";
import { startResearchRun } from "../domain/research/run.ts";
import { searchResearchQuery } from "../domain/research/search.ts";
import {
  deleteRunFiles,
  endRun,
  postsRequestOf,
  type RunEnd,
  readPageFile,
  reserveCredits,
  reserveEngagerCredit,
  reserveRead,
  settleCredits,
  settleEngagerCredit,
  settleRead,
  stagePage,
  stagePosts,
  startRun,
  writeRunFile,
} from "../domain/runs.ts";
import { DAILY_RUNS_TICK_MINUTES } from "../domain/schedule/constants.ts";
import { startDailyRuns } from "../domain/schedule/daily.ts";
import { triageByRules, triageCandidates } from "../domain/triage/triage.ts";
import { errors } from "../errors.ts";

const id = z.string().min(1).max(64);
/** A run, scheduled (no runId: the workflow makes it) or by hand (the row's). */
export const runInput = workflowInput.extend({ sourceId: id, runId: id.optional() });
const step = workflowInput.extend({ sourceId: id, runId: id });
/** A research run: always by its row, which the tick or Run now wrote (gamma-wr-030). */
export const researchRunInput = step;
/** A step that reads the run's audience: its agent's, the one its start named, else the default. */
const audienceStep = step.extend({ playbookId: id.optional() });
const count = z.int().min(0);
const fileKey = z.string().min(1).max(1024);
/** A post's URL, a posts kind's in its unnamed form, which names nobody. */
const postUrl = z.string().min(1).max(2048);
type Tx = ActivityContext<TenantClient>;
let log: ReturnType<typeof createLogger> | undefined;

export const workflows = defineWorkflows({
  signals_run: { input: runInput, taskQueue: DEFAULT_TASK_QUEUE },
  /** A research source's run (gamma-wr-030): its frame; its plan since gamma-wr-040, its search since gamma-wr-041. */
  signals_research_run: { input: researchRunInput, taskQueue: DEFAULT_TASK_QUEUE },
  signals_evidence_reduction: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  signals_evidence_reduction_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
  signals_daily_runs_tick: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
});

export const activities = {
  /** The run's row, with the id of the workflow that runs it, a schedule's included (fix-run-stop). */
  signals_run_start: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => context.tenant(() => startRun(ref, context.workflowId)),
  }),
  /** A research run's first step: its row as every run's, and the audience's countries, counted. */
  signals_research_start: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => context.tenant(() => startResearchRun(ref, context.workflowId)),
  }),
  /**
   * A research run's plan (gamma-wr-040): the trade's words, the source types and the queries, written
   * by the model outside any run, between two runs; counts out, never a word or a query. The agent not
   * loaded is never retried: the run ends `failed`.
   */
  signals_research_plan: defineActivity({
    kind: "ai",
    input: audienceStep,
    notRetried: [errors.signal_research_agent_not_loaded],
    run: (input, context: Tx) => planResearchRun(input, context.tenant),
  }),
  /**
   * A research run's search of one query of its plan, by its position (gamma-wr-041): through the
   * counted search, the answer to a file, the query marked asked; a status out, never a query.
   */
  signals_research_search: defineActivity({
    kind: "provider",
    input: step.extend({ position: z.int().min(1) }),
    run: ({ position, ...ref }, context: Tx) => searchResearchQuery(ref, position, context.tenant),
  }),
  /**
   * A research run's pick among one search's results, by its position (gamma-wr-045): the model asked
   * outside any run, between two runs; the picks kept in a file, a status and a count out, never a
   * link. The agent not loaded is never retried: the run ends `failed`.
   */
  signals_research_pick: defineActivity({
    kind: "ai",
    input: step.extend({ position: z.int().min(1) }),
    notRetried: [errors.signal_research_pick_agent_not_loaded],
    run: ({ position, ...ref }, context: Tx) => pickResearchResults(ref, position, context.tenant),
  }),
  /** A research run's queue of pages: the start pages and the picks, in a file; a count out. */
  signals_research_queue: defineActivity({
    kind: "db",
    input: step.extend({ searches: count }),
    run: ({ searches, ...ref }, context: Tx) => queueResearchPages(ref, searches, context.tenant),
  }),
  /**
   * A research run's read of one page of its queue, by its place in it, `read` pages having been read
   * before (gamma-wr-045): the platform's reader, the page kept in a file; a status out, never a link.
   */
  signals_research_page: defineActivity({
    kind: "provider",
    input: step.extend({ index: z.int().min(1), read: count }),
    run: ({ index, read, ...ref }, context: Tx) => readQueuedPage(ref, index, read, context.tenant),
  }),
  /**
   * A research run's candidates from earlier runs (gamma-wr-046): the ones left pending are checked
   * against the never-contact list and the own company again, a count out.
   */
  signals_research_carry: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => carryCandidates(ref, context.tenant),
  }),
  /**
   * What one page of the queue is and the companies it names (gamma-wr-046): the model asked outside
   * any run, the gated companies kept in a file; a status and a count out, never a name. The agent
   * not loaded is never retried: the run ends `failed`.
   */
  signals_research_read: defineActivity({
    kind: "ai",
    input: step.extend({ index: z.int().min(1) }),
    notRetried: [errors.signal_research_read_agent_not_loaded],
    run: ({ index, ...ref }, context: Tx) => readPageCompanies(ref, index, context.tenant),
  }),
  /**
   * The candidates of one page's companies (gamma-wr-046): a search by name for a company with no link,
   * the drops, the rows; a status and a count out, never a name.
   */
  signals_research_candidates: defineActivity({
    kind: "provider",
    input: step.extend({ index: z.int().min(1) }),
    run: ({ index, ...ref }, context: Tx) => makeCandidates(ref, index, context.tenant),
  }),
  /** A research run's queue of companies to judge (gamma-wr-050): the pending candidates' ids, in a file; a count out. */
  signals_research_judge_queue: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => queueCompanies(ref, context.tenant),
  }),
  /**
   * The own site of one company of the judge queue, by its place in it, `judged` companies having been
   * judged before (gamma-wr-050): enrichment's reader, the pages kept in a file, a candidate whose site
   * cannot be read dropped with the reader's code; a status out, never a link.
   */
  signals_research_site: defineActivity({
    kind: "provider",
    input: step.extend({ index: z.int().min(1), judged: count, priced: z.boolean().optional() }),
    run: ({ index, judged, priced, ...ref }, context: Tx) =>
      readCandidateSite(ref, index, judged, context.tenant, priced === true),
  }),
  /**
   * The judgment of one company of the judge queue (gamma-wr-050): the model asked outside any run, its
   * answers gated, the verdict decided by code, the found company kept; a status and a verdict out, never
   * a quote. The agent not loaded is never retried: the run ends `failed`.
   */
  signals_research_judge: defineActivity({
    kind: "ai",
    input: audienceStep.extend({ index: z.int().min(1) }),
    notRetried: [errors.signal_research_judge_agent_not_loaded],
    run: ({ index, ...ref }, context: Tx) => judgeCompany(ref, index, context.tenant),
  }),
  /**
   * A research run's queue of found companies whose people are taken (gamma-wr-060): the ids of those
   * judged `fit` whose people were not taken, in a file; a count out.
   */
  signals_research_people_queue: defineActivity({
    kind: "db",
    input: step,
    run: (ref, context: Tx) => queuePeople(ref, context.tenant),
  }),
  /**
   * The people of one found company of the people queue, by its place in it (gamma-wr-060): the pages
   * read, the model asked twice outside any run (who the pages name, then who fits by role alone), the
   * people with a key the page printed made leads, the company marked, all inside this one step; a
   * status and a count out, never a name, a role, a link or an address. The agents not loaded are never
   * retried: the run ends `failed`.
   */
  signals_research_people: defineActivity({
    kind: "ai",
    input: audienceStep.extend({ index: z.int().min(1) }),
    notRetried: [errors.signal_research_people_agent_not_loaded],
    run: ({ index, ...ref }, context: Tx) => takePeople(ref, index, context.tenant),
  }),
  /** A research run's last step, whatever the end: no read, block or file to settle. */
  signals_research_end: defineActivity({
    kind: "db",
    input: step.extend({
      status: z.enum(["done", "failed", "cancelled"]),
      /** The place in the judge queue of a company whose credit is open (gamma-wr-051). */
      openCompany: z.int().min(1).optional(),
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
    }),
    run: async ({ status, code, openCompany, ...ref }, context: Tx) => {
      const end: RunEnd =
        status === "failed" ? { status, code: code ?? "activity_failed" } : { status };
      if (openCompany !== undefined) await releaseOpenCompany(ref, openCompany, context.tenant);
      return context.tenant(() => endRun(ref, end, { read: 0, billed: 0 }));
    },
  }),
  signals_reserve_read: defineActivity({
    kind: "db",
    input: step.extend({
      accountId: id,
      kind: z.enum(["read_engagers", "read_profile", "read_posts"]).default("read_engagers"),
      /** A run started since gamma-p5-040: its read budget and the reads it made. */
      budget: z.strictObject({ readBudget: count, used: count }).optional(),
    }),
    run: (input, context: Tx) =>
      context.tenant(() => reserveRead(input, input.accountId, input.kind, input.budget)),
  }),
  signals_settle_read: defineActivity({
    kind: "db",
    input: step.extend({ reservationId: id, made: z.boolean() }),
    run: (input, context: Tx) => context.tenant(() => settleRead(input.reservationId, input.made)),
  }),
  /** A run started before beta-p1-090: a block of credits for its pages' engagers. */
  signals_reserve_credits: defineActivity({
    kind: "db",
    input: step.extend({ attempt: z.int().min(1), quantity: z.int().min(1), billed: count }),
    run: (input, context: Tx) =>
      context.tenant(() => reserveCredits(input, input.attempt, input.quantity, input.billed)),
  }),
  signals_settle_credits: defineActivity({
    kind: "db",
    input: step.extend({ usageId: id, read: count, billed: count }),
    run: ({ usageId, read, billed }, context: Tx) =>
      context.tenant(() => settleCredits(usageId, read, billed)),
  }),
  /** A candidate's credit for its profile read, its `n`th reservation in the run (beta-p1-090). */
  signals_reserve_engager_credit: defineActivity({
    kind: "db",
    input: step.extend({ candidateId: id, n: z.int().min(1) }),
    run: (input, context: Tx) =>
      context.tenant(() => reserveEngagerCredit(input, input.candidateId, input.n)),
  }),
  /** The candidate's credit: committed when the read returned the profile, released otherwise. */
  signals_settle_engager_credit: defineActivity({
    kind: "db",
    input: step.extend({ usageId: id, read: z.boolean() }),
    run: ({ usageId, read }, context: Tx) =>
      context.tenant(() => settleEngagerCredit(usageId, read)),
  }),
  /** A page of engagers: of the source's post, or of a posts kind's post, with its page of posts. */
  signals_stage_page: defineActivity({
    kind: "db",
    input: step.extend({
      page: z.int().min(1),
      key: fileKey,
      cutAt: z.iso.datetime(),
      read: count,
      post: z.strictObject({ postUrl, postsKey: fileKey }).optional(),
    }),
    run: async (input, context: Tx) => {
      const { workspaceId, post } = input;
      const file = await readPageFile(workspaceId, input.key);
      const posts = post && {
        postUrl: post.postUrl,
        file: await readPageFile(workspaceId, post.postsKey),
      };
      const page = { number: input.page, key: input.key, cutAt: input.cutAt, read: input.read };
      return context.tenant(() => stagePage(input, page, file, posts));
    },
  }),
  /** A posts kind's page of posts: its request file written, outside any run; `gone` with the source. */
  signals_posts_request: defineActivity({
    kind: "db",
    input: step.extend({ page: z.int().min(1), cutAt: z.iso.datetime() }),
    run: async (input, context: Tx) => {
      const { runId, page, cutAt } = input;
      const after = page > 1 ? postsKeys(runId, page - 1).rawKey : undefined;
      const request = await context.tenant(() => postsRequestOf(input, page, cutAt, after));
      if (request !== null)
        await writeRunFile(input.workspaceId, postsKeys(runId, page).requestKey, request);
      return { gone: request === null };
    },
  }),
  /** A posts kind's page of posts staged: its authors, its posts' unnamed URLs and cuts. */
  signals_stage_posts: defineActivity({
    kind: "db",
    input: step.extend({ page: z.int().min(1), key: fileKey, cutAt: z.iso.datetime() }),
    run: async (input, context: Tx) => {
      const file = await readPageFile(input.workspaceId, input.key);
      const page = { number: input.page, key: input.key, cutAt: input.cutAt };
      return context.tenant(() => stagePosts(input, page, file));
    },
  }),
  /**
   * The cheap drops; the ids left, oldest staged first, for the triage (`triage`, a run started since
   * signals-triage-ai); else after the recruiters and job seekers too, in the rules' read order, a
   * request file each.
   */
  signals_select_candidates: defineActivity({
    kind: "db",
    input: audienceStep.extend({ triage: z.literal(true).optional() }),
    run: async ({ triage, ...ref }, context: Tx) => {
      const ownName = await ownCompanyName(ref.workspaceId);
      const triaged = triage === true;
      const selected = await context.tenant(() => selectCandidates(ref, ownName, triaged));
      if (!triaged) await writeRequests(ref.workspaceId, ref.runId, selected);
      return { candidateIds: selected.map((candidate) => candidate.id) };
    },
  }),
  /**
   * A batch triaged by the headlines (domain/triage/): the model asked outside any run, between two
   * runs; the skips deleted, a request file per candidate read, their ids in the read order's ranks.
   * The agent not loaded is never retried: the run decides the batch by the rules.
   */
  signals_triage_candidates: defineActivity({
    kind: "ai",
    input: audienceStep.extend({ candidateIds: z.array(id).min(1).max(TRIAGE_BATCH_SIZE) }),
    notRetried: [errors.signal_triage_agent_not_loaded],
    run: (input, context: Tx) => triageCandidates(input, input.candidateIds, context.tenant),
  }),
  /** A batch the triage could not answer, decided by the rules, as before it. */
  signals_triage_fallback: defineActivity({
    kind: "db",
    input: audienceStep.extend({ candidateIds: z.array(id).min(1).max(TRIAGE_BATCH_SIZE) }),
    run: (input, context: Tx) => triageByRules(input, input.candidateIds, context.tenant),
  }),
  /** A chunk of candidates whose profiles were read, their files read before the run. */
  signals_process_candidates: defineActivity({
    kind: "db",
    input: audienceStep.extend({ candidateIds: z.array(id).min(1).max(PROCESS_CHUNK) }),
    run: async (input, context: Tx) => {
      const { workspaceId, runId, candidateIds } = input;
      const profiles = await readProfiles(workspaceId, runId, candidateIds);
      const ownName = await ownCompanyName(workspaceId);
      return context.tenant(() => processCandidates(input, candidateIds, profiles, ownName));
    },
  }),
  /**
   * The source's oldest unrated events with words or a post, at most SIGNALS_RATE_MAX_EVENTS_PER_RUN
   * (gamma-p5-030; the select's LIMIT).
   */
  signals_select_ratings: defineActivity({
    kind: "db",
    input: step,
    run: async (ref, context: Tx) => ({ eventIds: await context.tenant(() => selectRatings(ref)) }),
  }),
  /** A batch of them rated: the model asked outside any run, between two runs (domain/rate/). */
  signals_rate_events: defineActivity({
    kind: "ai",
    input: step.extend({ eventIds: z.array(id).min(1).max(RATE_BATCH_SIZE) }),
    run: (input, context: Tx) => rateEvents(input, input.eventIds, context.tenant),
  }),
  /**
   * The rated and unrated of the events the select picked. No maximum here, so that the schema reads
   * no setting: the ids are the select's answer, bounded by its LIMIT (README.md "Settings").
   */
  signals_count_ratings: defineActivity({
    kind: "db",
    input: step.extend({ eventIds: z.array(id).min(1) }),
    run: (input, context: Tx) => context.tenant(() => countRatings(input.runId, input.eventIds)),
  }),
  signals_run_end: defineActivity({
    kind: "db",
    input: step.extend({
      status: z.enum(["done", "failed", "cancelled"]),
      code: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
      newest: z.iso.datetime().optional(),
      /** A posts kind's done run: each post read and its newest staged (the watermark). */
      posts: z.array(z.strictObject({ postUrl, newest: z.iso.datetime().optional() })).optional(),
      /** A done run its budget, the cap or the 200 ended (gamma-p5-040): the watermark stays. */
      budgetReached: z.literal(true).optional(),
      usageId: id.optional(),
      read: count,
      billed: count,
    }),
    run: async (input, context: Tx) => {
      const { status, code, newest, posts, budgetReached, usageId, read, billed, ...ref } = input;
      // Outside the run and before it, so a retry deletes what is left; raw/'s 72 hours catch a miss.
      await deleteRunFiles(ref.workspaceId, ref.runId).catch((error: unknown) => {
        const fields = { run_id: ref.runId, code: isAppError(error) ? error.code : "unknown" };
        (log ??= createLogger()).warn(fields, "signals: the run's files stay until raw/ expires");
      });
      const end: RunEnd =
        status === "failed"
          ? { status, code: code ?? "activity_failed" }
          : status === "done"
            ? { status, newest, posts, budgetReached }
            : { status };
      return context.tenant(() => endRun(ref, end, { usageId, read, billed }));
    },
  }),
  /** The tick's: every workspace's reduction started, unless one runs; the counts. */
  signals_start_reductions: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: startReductions,
  }),
  /** The daily tick's: in each workspace's own run, a run of every source due written; the counts. */
  signals_start_daily_runs: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: () => startDailyRuns(),
  }),
  /** The workspace's evidence past its kind's lookback reduced, a batch per run; the count logged. */
  signals_reduce_evidence: defineActivity({
    kind: "db",
    input: workflowInput,
    run: async (_input, context: Tx) => {
      const reduced = await reduceEvidence(context.tenant);
      (log ??= createLogger()).info({ reduced_count: reduced }, "signals: evidence reduced");
      return { reduced };
    },
  }),
};

/** Daily at 03:00 UTC; Temporal's default overlap policy skips a tick while one runs. */
const daily = { cronExpressions: ["0 3 * * *"], timezone: "UTC" };
/** Every DAILY_RUNS_TICK_MINUTES, skipped while one runs: a tick missed costs nothing. */
const dailyRuns = { intervals: [{ every: DAILY_RUNS_TICK_MINUTES * 60_000 }] };
export const schedules = defineSchedules([
  {
    id: "evidence_reduction",
    workflow: "signals_evidence_reduction_tick",
    spec: daily,
    input: {},
  },
  {
    id: "daily_runs",
    workflow: "signals_daily_runs_tick",
    spec: dailyRuns,
    input: {},
  },
]);
