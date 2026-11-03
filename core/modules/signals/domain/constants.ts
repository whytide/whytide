// signals' constants for its runs (README.md "Runs").

/** A run in these states has ended: a stop answers signal_run_not_open (fix-run-stop). */
export const ENDED = ["done", "failed", "cancelled"] as const;

/** The workflow id of a run by hand, which the worker starts on signals.run_requested. */
export const runNowWorkflowIdOf = (workspaceId: string, runId: string): string =>
  `signals.run:${workspaceId}:${runId}`;
