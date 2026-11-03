// The wait before a retry (coding §9: backoff with jitter, then a dead-letter state), a pure function.

export type BackoffOptions = {
  /** The wait after the first failure, before jitter; one second. */
  readonly baseMs?: number;
  /** The longest wait, before jitter; fifteen minutes. */
  readonly capMs?: number;
  /** A number in [0, 1): Math.random, or a test's constant. */
  readonly random?: () => number;
};

/**
 * Milliseconds to wait after failure number `attempt` (1 for the first): base·2^(attempt−1), capped,
 * with equal jitter, half of it fixed and half random. So the waits grow with every attempt until the
 * cap, and two rows that failed together do not come back together.
 */
export function backoffMs(
  attempt: number,
  { baseMs = 1_000, capMs = 15 * 60_000, random = Math.random }: BackoffOptions = {},
): number {
  const exponent = Math.min(Math.max(Math.floor(attempt) - 1, 0), 40);
  const full = Math.min(capMs, baseMs * 2 ** exponent);
  return Math.floor(full / 2 + random() * (full / 2));
}
