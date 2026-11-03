// signals' constants for its runs (README.md "Runs").

/** A run in these states has ended: a stop answers signal_run_not_open (fix-run-stop). */
export const ENDED = ["done", "failed", "cancelled"] as const;

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
