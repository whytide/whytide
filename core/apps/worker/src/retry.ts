// The retry policy by activity kind (docs/workflows.md "Retries"): a provider call gets five
// attempts on Temporal's backoff (1 s, doubling), AI and database work three. A code that would fail
// the same way again, or would pay the model again, is never retried. An `ai_failed` result is a
// value callAgent returns, never a throw, so it is no failure here. A provider that says when to come
// back (a rate limit's `details.retryAfterSec`) sets the next attempt's delay instead, 15 minutes at
// most.
import { type ActivityKind, isAppError } from "@whytide/platform";

export const ACTIVITY_ATTEMPTS: Readonly<Record<ActivityKind, number>> = {
  provider: 5,
  ai: 3,
  db: 3,
};
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

/** Whether a failed attempt is retried: its code is off NOT_RETRIED and its kind has attempts left. */
export function retries(kind: ActivityKind, code: string, attempt: number): boolean {
  return !NOT_RETRIED.has(code) && attempt < ACTIVITY_ATTEMPTS[kind];
}

const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** The provider's own wait before the next attempt, in milliseconds; undefined for the backoff. */
export function retryDelayMs(error: unknown): number | undefined {
  const seconds = isAppError(error) ? error.details?.retryAfterSec : undefined;
  if (typeof seconds !== "number" || !(seconds > 0)) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
}
