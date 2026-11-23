// The retry policy (docs/workflows.md "Retries"): an activity gets its kind's attempts, the
// platform's ACTIVITY_ATTEMPTS, a provider call five on Temporal's backoff (1 s, doubling), AI and
// database work three, or fewer of its own (`attempts`). A code that would fail the same way again,
// or would pay the model again, is never retried: NOT_RETRIED for every activity, and an activity's
// own `notRetried`. An `ai_failed` result is a value callAgent returns, never a throw, so it is no
// failure here. A provider that says when to come back (a rate limit's `details.retryAfterSec`) sets
// the next attempt's delay instead, 15 minutes at most.
import { ACTIVITY_ATTEMPTS, type ActivityRetries, isAppError } from "@whytide/platform";

export const NOT_RETRIED: ReadonlySet<string> = new Set([
  "llm_invalid_key",
  "llm_input_invalid",
  "ai_input_invalid",
  "ai_budget_exceeded",
  "cost_price_missing",
  "activity_input_invalid",
  "activity_attempts_exhausted",
  "activity_not_in_workflow",
]);

/** An activity's own bound: its `attempts`, never past its kind's, which defineActivity checks too. */
export function attemptsOf({ kind, attempts }: ActivityRetries): number {
  const bound = ACTIVITY_ATTEMPTS[kind];
  return Math.min(attempts ?? bound, bound);
}

/**
 * Whether a failed attempt is retried: its code is off NOT_RETRIED and off the activity's
 * notRetried, and the activity has attempts left.
 */
export function retries(activity: ActivityRetries, code: string, attempt: number): boolean {
  const own = activity.notRetried ?? [];
  return !NOT_RETRIED.has(code) && !own.includes(code) && attempt < attemptsOf(activity);
}

const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** The provider's own wait before the next attempt, in milliseconds; undefined for the backoff. */
export function retryDelayMs(error: unknown): number | undefined {
  const seconds = isAppError(error) ? error.details?.retryAfterSec : undefined;
  if (typeof seconds !== "number" || !(seconds > 0)) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}
