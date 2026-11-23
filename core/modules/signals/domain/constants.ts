// signals' constants for its runs (README.md "Runs") and who writes every source. No import: the
// screen reads them too.

/**
 * The roles of signals.manage (permissions.ts): who writes every source, another member's included
 * (README "Decided here"); the screen asks it too.
 */
export const SIGNALS_MANAGE_ROLES = ["Owner", "Admin"] as const;

/** A run in these states has ended: a stop answers signal_run_not_open (fix-run-stop). */
export const ENDED = ["done", "failed", "cancelled"] as const;

/**
 * The status of playbooks' agent whose sources read (paused-agent-sources): a paused agent's read
 * nothing, whatever the pause's reason, and an archived one holds no source.
 */
export const READING_AGENT_STATUS = "active";

/** The workflow id of a run by hand, which the worker starts on signals.run_requested. */
export const runNowWorkflowIdOf = (workspaceId: string, runId: string): string =>
  `signals.run:${workspaceId}:${runId}`;

/**
 * SIGNALS_CREDITS_PER_ENGAGER (settings.ts): the credits of one engager's profile read, the price of
 * signals.engager (beta-p1-090), and its bounds.
 */
export const CREDITS_PER_ENGAGER = { default: 1, min: 0, max: 100 } as const;

/** signals.engager's quantity for one candidate's profile read. */
export const ENGAGERS_PER_READ = 1;

/**
 * SIGNALS_CREDITS_PER_RESEARCHED_COMPANY (settings.ts): the credits of one company a research run
 * reads and judges, the price of signals.researched_company (gamma-wr-051), with the bounds of
 * SIGNALS_CREDITS_PER_ENGAGER.
 */
export const CREDITS_PER_RESEARCHED_COMPANY = { default: 1, min: 0, max: 100 } as const;

/** signals.researched_company's quantity for one company. */
export const COMPANIES_PER_PRICE = 1;

/**
 * The key of a company's credit in a research run (gamma-wr-051): a candidate is judged once in a run,
 * so a key is used once, and a retried step finds its row and charges once.
 */
export const companyCreditKeyOf = (runId: string, candidateId: string): string =>
  `sigco:${runId}:${candidateId}`;

/**
 * The key of a candidate's credit (beta-p1-090): `n` counts the candidate's reservations in the run
 * from 1, so a released key, which credits answers with its old row, is never reserved again.
 */
export const engagerCreditKeyOf = (runId: string, candidateId: string, n: number): string =>
  `sigprof:${runId}:${candidateId}:${n}`;

/**
 * The patch of signals_run that prices each engager read (beta-p1-090): a run started before it
 * replays without its marker and keeps its blocks of `signals.engager_read`.
 */
export const ENGAGER_PRICE_PATCH = "engager-price";

/**
 * The patch of signals_research_run that prices each company judged (gamma-wr-051): a run started
 * before it replays without its marker and judges its companies for nothing.
 */
export const RESEARCH_PRICE_PATCH = "research-price";

/**
 * The patch of signals_run that reads a posts kind's posts, then each post's engagers (gamma-p5-020):
 * a run started before it replays without its marker on its old path.
 */
export const POSTS_READER_PATCH = "posts-reader";

/**
 * The patch of signals_run that rates the source's events after the processing (gamma-p5-030): a
 * run started before it replays without its marker and rates nothing.
 */
export const RATE_ENGAGEMENT_PATCH = "rate-engagement";

/** The events of one rating call (gamma-p5-030). */
export const RATE_BATCH_SIZE = 10;

/**
 * SIGNALS_RATE_MAX_EVENTS_PER_RUN's default (settings.ts, README.md "Settings"): the events a run
 * rates at most, the source's oldest unrated first (not in the sources).
 */
export const RATED_PER_RUN = { default: 100 } as const;

/**
 * The patch of signals_run that reads within the run's read budget (gamma-p5-040): a run started
 * before it replays without its marker on its old path, with no budget and no reads kept.
 */
export const READ_BUDGET_PATCH = "read-budget";

/**
 * signals_reserve_read's refusal once a run made the reads of its budget: the slot the account granted
 * goes back at once.
 */
export const READ_BUDGET_REACHED = "read_budget_reached";

/**
 * The read refusals that end a budgeted run's day of reading (README.md "Runs"): its budget,
 * linkedin's cap or its reads kept for the send path, and the day's 200 actions. The run ends done
 * with `counts.budget_reached`, its watermark kept; the next day's run reads on.
 */
export const DAY_READING_ENDS: readonly string[] = [
  READ_BUDGET_REACHED,
  "read_cap_reached",
  "daily_actions_cap_reached",
];

/** The count of a run its budget, the cap or the 200 ended: 1. */
export const BUDGET_REACHED = "budget_reached";

/**
 * The patch of signals_run that triages its candidates by their headline before the first profile
 * read (signals-triage-ai): a run started before it replays without its marker on its old path, the
 * keyword drops and the title rule's read order in signals_select_candidates.
 */
export const HEADLINE_TRIAGE_PATCH = "headline-triage";

/**
 * The candidates of one triage call (signals-triage-ai): with the largest ICP, 25 headlines in a
 * non-Latin script stay within the agent's input budget.
 */
export const TRIAGE_BATCH_SIZE = 25;

/**
 * A research run's end code when its audience names no country (gamma-wr-030): the code in signals'
 * errors, its words on the runs panel. In this file for the workflow's sandbox, which imports no
 * registry.
 */
export const RESEARCH_NO_COUNTRY = "research_no_country";

/** The code a research run ends `failed` with when a company's credit is refused (credits' own code, gamma-wr-051). */
export const INSUFFICIENT_CREDITS = "insufficient_credits";

/** The workflow of a research source's run (workflows/workflows.ts; gamma-wr-030). */
export const RESEARCH_WORKFLOW = "signals_research_run";

/**
 * The patch of signals_research_run that plans the run after its start (gamma-wr-040): a run started
 * before it replays without its marker and ends `done` after its start, as gamma-wr-030's did.
 */
export const RESEARCH_PLAN_PATCH = "research-plan";

/**
 * A research run's end code when its plan could not be written (gamma-wr-040): the code in signals'
 * errors, its words on the runs panel.
 */
export const RESEARCH_PLAN_FAILED = "research_plan_failed";

/**
 * The patch of signals_research_run that searches the plan's queries after the plan (gamma-wr-041): a
 * run started before it replays without its marker and ends `done` after its plan, as gamma-wr-040's
 * did. Under it the plan's step also gets a longer timeout, for the model's retries.
 */
export const RESEARCH_SEARCH_PATCH = "research-search";

/**
 * A research run's end code when no search adapter is loaded (gamma-wr-041): the code in signals'
 * errors, its words on the runs panel. With no search at all the source can find nothing.
 */
export const RESEARCH_SEARCH_UNAVAILABLE = "research_search_unavailable";

/**
 * The patch of signals_research_run that picks the results to read and reads their pages after the
 * searches (gamma-wr-045): a run started before it replays without its marker and ends `done` after
 * its searches, as gamma-wr-041's did.
 */
export const RESEARCH_PAGES_PATCH = "research-pages";

/**
 * The patch of signals_research_run that says what each page read is and makes the candidates of the
 * companies it names (gamma-wr-046): a run started before it replays without its marker and ends
 * `done` after its pages, as gamma-wr-045's did.
 */
export const RESEARCH_CANDIDATES_PATCH = "research-candidates";

/**
 * The patch of signals_research_run that reads each candidate's own site and judges the company
 * (gamma-wr-050): a run started before it replays without its marker and ends `done` after its
 * candidates, as gamma-wr-046's did.
 */
export const RESEARCH_JUDGE_PATCH = "research-judge";

/**
 * The patch of signals_research_run that takes the people of each company judged `fit` (gamma-wr-060): a
 * run started before it replays without its marker and ends `done` after its judgments, as
 * gamma-wr-050's did.
 */
export const RESEARCH_PEOPLE_PATCH = "research-people";

/**
 * The patch of signals_research_run that gives the people step the time of the managers' search
 * (gamma-wr-090): the step asks one more search and two more model calls, so its timeout is longer. A run
 * started before it replays without its marker and keeps the step's first timeout.
 */
export const RESEARCH_MANAGERS_PATCH = "research-managers";
