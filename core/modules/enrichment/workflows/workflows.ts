// enrichment's workflows, run in Temporal's sandbox (README "How it works", docs/flows.md): the tick,
// global, which starts one batch per workspace with a held lead; the workspace's batch, which opens a
// new_lead run per held lead and runs it as a child, one after another; and a run: its prepare
// step, the pass over its plan, each source asked once, and its finish, which releases the lead's
// hold whatever happened. A source step that fails for any reason, a worker restart included, is
// recorded failed and the pass goes on; a failure of the run's own steps ends it failed. Ids, source
// names, field names and codes in and out. The email lookup's workflow is lookup.ts's (gamma-en-080).
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  executeChild,
  isCancellation,
  proxyActivities,
  TimeoutFailure,
} from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { ACTIVITY_FAILED, type Field, type Input } from "../domain/constants.ts";
import { inputsAdded, nextSource, type Plan, type PlanEntry } from "../domain/plan.ts";
import type { activities } from "./index.ts";

export { enrichment_lookup } from "./lookup.ts";

type Activities = ActivityFunctions<typeof activities>;
// Cancelled, a workflow waits for the step under way, so the finish never races it.
const cancellationType = ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
const steps = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", cancellationType });

/** What a run did: the fields filled, and whether its own steps failed. */
export type RunResult = { readonly filled: readonly string[]; readonly failed: boolean };
/** What a batch did, counted: the held leads read, the runs it ran, those that ended failed. */
export type BatchResult = {
  readonly leads: number;
  readonly runs: number;
  readonly failed: number;
};

/** The source's step in its kind's activity, with its timeout: one attempt when it calls out. */
function sourceStep(entry: PlanEntry) {
  const once = entry.activityKind === "db" ? {} : { retry: { maximumAttempts: 1 } };
  const startToCloseTimeout = entry.timeoutSeconds * 1000;
  const proxies = proxyActivities<Activities>({ startToCloseTimeout, cancellationType, ...once });
  if (entry.activityKind === "ai") return proxies.enrichment_source_ai;
  return entry.activityKind === "db" ? proxies.enrichment_source_db : proxies.enrichment_source;
}

/** A failed step's code: its failure's type, a timeout's, else activity_failed. */
function codeOf(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : undefined;
  if (cause instanceof ApplicationFailure && cause.type) return cause.type;
  return cause instanceof TimeoutFailure ? "activity_timeout" : ACTIVITY_FAILED;
}

/** The pass: the next source from the top each time, until none is left to ask. */
async function pass(input: { workspaceId: string; runId: string }, plan: Plan): Promise<void> {
  const asked = new Set<string>();
  const have = new Set<Input>(plan.have);
  const open = new Set<Field>(plan.wanted);
  for (;;) {
    const entry = nextSource(plan, asked, have, open);
    if (entry === undefined) return;
    asked.add(entry.source);
    const step = { ...input, source: entry.source };
    try {
      const { filled } = await sourceStep(entry)(step);
      for (const field of filled) open.delete(field);
      for (const added of inputsAdded(filled)) have.add(added);
    } catch (error) {
      if (isCancellation(error)) throw error;
      await steps.enrichment_source_failed({ ...step, code: codeOf(error) });
    }
  }
}

export async function enrichment_run(input: {
  workspaceId: string;
  runId: string;
}): Promise<RunResult> {
  try {
    await pass(input, await steps.enrichment_prepare(input));
  } catch (error) {
    const ended = () => steps.enrichment_finish({ ...input, failed: true });
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(ended);
      throw error;
    }
    return { filled: (await ended()).filled, failed: true };
  }
  return { filled: (await steps.enrichment_finish(input)).filled, failed: false };
}

/** The held leads, oldest first, each with its new_lead run as a child, one after another. */
export async function enrichment_batch(input: { workspaceId: string }): Promise<BatchResult> {
  const { workspaceId } = input;
  const personIds = await steps.enrichment_held_leads(input);
  const counts = { leads: personIds.length, runs: 0, failed: 0 };
  for (const personId of personIds) {
    const { runId } = await steps.enrichment_open_run({ workspaceId, personId });
    if (runId === null) continue;
    counts.runs += 1;
    try {
      // events.ts runStart's id: the sandbox imports no module code that subscribes.
      const workflowId = `enrichment.run:${workspaceId}:${runId}`;
      const run = await executeChild(enrichment_run, {
        args: [{ workspaceId, runId }],
        workflowId,
      });
      if (run.failed) counts.failed += 1;
    } catch (error) {
      if (isCancellation(error)) throw error;
      counts.failed += 1;
    }
  }
  return counts;
}

export async function enrichment_tick(input: Record<string, never>) {
  return steps.enrichment_start_batches(input);
}
