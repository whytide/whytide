// The email lookup's workflow, run in Temporal's sandbox (README "Email lookups", docs/flows.md "The
// lookup"): its prepare step, then the email sources in the plan's order, each asked once, each new
// candidate passed to the verifiers in their turns until one gives a verdict; then its settle. It
// stops at the first valid verdict, a catch_all on a work address, the plan's most candidates
// verified, no verifier left, or no source left. A source or a verifier whose step fails for any
// reason is recorded failed and the next one is asked; never retried. A candidate no verifier could
// check ends the lookup: waiting_allowance when one had no calls left, else failed with the last
// error's code, so a vendor's outage never leaves a negative entry. A re-verification checks its
// contact point only (n = 0). Ids, names, numbers and codes in and out: the addresses stay in their
// files.
import {
  ActivityCancellationType,
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  isCancellation,
  proxyActivities,
  TimeoutFailure,
} from "@temporalio/workflow";
import type { ActivityFunctions } from "@whytide/platform";
import { ACTIVITY_FAILED, PROVIDER_TIMEOUT_SECONDS } from "../domain/constants.ts";
import type { LookupEnd } from "../domain/lookup/outcome.ts";
import type { LookupPlanEntry } from "../domain/lookup/prepare.ts";
import type { VerifyResult } from "../domain/lookup/verify.ts";
import type { activities } from "./index.ts";

type Activities = ActivityFunctions<typeof activities>;
type Input = { workspaceId: string; requestId: string };
// Cancelled, a workflow waits for the step under way, so the settle never races it.
const cancellationType = ActivityCancellationType.WAIT_CANCELLATION_COMPLETED;
const once = { maximumAttempts: 1 };
const steps = proxyActivities<Activities>({ startToCloseTimeout: "1 minute", cancellationType });
const verifiers = proxyActivities<Activities>({
  startToCloseTimeout: PROVIDER_TIMEOUT_SECONDS * 1000,
  cancellationType,
  retry: once,
});

/** The source's step in its kind's activity, with its timeout, once. */
function findStep(entry: LookupPlanEntry) {
  const startToCloseTimeout = entry.timeoutSeconds * 1000;
  const proxies = proxyActivities<Activities>({
    startToCloseTimeout,
    cancellationType,
    retry: once,
  });
  if (entry.activityKind === "ai") return proxies.enrichment_find_ai;
  return entry.activityKind === "db" ? proxies.enrichment_find_db : proxies.enrichment_find;
}

/** A failed step's code: its failure's type, a timeout's, else activity_failed. */
function codeOf(error: unknown): string {
  const cause = error instanceof ActivityFailure ? error.cause : undefined;
  if (cause instanceof ApplicationFailure && cause.type) return cause.type;
  return cause instanceof TimeoutFailure ? "activity_timeout" : ACTIVITY_FAILED;
}

/** No verdict: a verifier had no calls left, or every one failed, the last with `code`. */
type NoVerdict =
  | { readonly end: "no_verifier" }
  | { readonly end: "failed"; readonly code: string };

/** The verifiers' turns on candidate n: the first verdict, or why there is none. */
async function check(
  input: Input,
  n: number,
  turns: readonly string[],
): Promise<VerifyResult | NoVerdict> {
  let spent = turns.length === 0;
  let code = ACTIVITY_FAILED;
  for (const verifier of turns) {
    try {
      const result = await verifiers.enrichment_verify({ ...input, n, verifier });
      if (result.outcome === "allowance_spent") spent = true;
      else if (result.outcome === "failed") code = result.code ?? ACTIVITY_FAILED;
      else return result;
    } catch (error) {
      if (isCancellation(error)) throw error;
      code = codeOf(error);
      await steps.enrichment_lookup_failed({ ...input, source: verifier, step: "verify", code });
    }
  }
  return spent ? { end: "no_verifier" } : { end: "failed", code };
}

/** The sources in order, each new candidate verified, until an end. */
async function walk(
  input: Input,
  plan: {
    sources: readonly LookupPlanEntry[];
    verifiers: readonly string[];
    maxCandidates: number;
  },
): Promise<LookupEnd> {
  let verified = 0;
  for (const entry of plan.sources) {
    let kept: readonly number[] = [];
    try {
      ({ kept } = await findStep(entry)({ ...input, source: entry.source }));
    } catch (error) {
      if (isCancellation(error)) throw error;
      const code = codeOf(error);
      await steps.enrichment_lookup_failed({ ...input, source: entry.source, step: "find", code });
    }
    for (const n of kept) {
      const turn = await check(input, n, plan.verifiers);
      if ("end" in turn) return turn;
      if (turn.outcome === "valid") return { end: "valid", n };
      // A domain that takes every address: no candidate there can be verified.
      if (turn.outcome === "catch_all" && !turn.personal) return { end: "catch_all", n };
      verified += 1;
      if (verified >= plan.maxCandidates) return { end: "exhausted" };
    }
  }
  return { end: "exhausted" };
}

/** A re-verification's end: its contact point's verdict, or why there is none. */
async function reverify(input: Input, turns: readonly string[]): Promise<LookupEnd> {
  const turn = await check(input, 0, turns);
  if ("end" in turn) return turn;
  if (turn.outcome === "valid" || turn.outcome === "catch_all") return { end: turn.outcome, n: 0 };
  return { end: "not_verified", n: 0 };
}

export async function enrichment_lookup(input: Input): Promise<{ status: string }> {
  let ended: LookupEnd;
  try {
    const plan = await steps.enrichment_lookup_prepare(input);
    if (plan.settled) return { status: plan.status };
    ended = plan.reverify ? await reverify(input, plan.verifiers) : await walk(input, plan);
  } catch (error) {
    if (isCancellation(error)) {
      const cancelled = { end: "failed", code: "activity_cancelled" } as const;
      await CancellationScope.nonCancellable(() =>
        steps.enrichment_lookup_settle({ ...input, ended: cancelled }),
      );
      throw error;
    }
    ended = { end: "failed", code: codeOf(error) };
  }
  return steps.enrichment_lookup_settle({ ...input, ended });
}
