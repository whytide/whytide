// The rounds of a lead's attempts at one ICP version (README "A new assessment"), pure: attempts 1 to
// 3 are the first round, 4 to 6 the second, and so on. The batch makes a lead ai_failed when the
// provider fails the last attempt of a round; a member's press moves the lead to the next round's
// first attempt, whose key no reservation has used, with the round's whole budget.
import { ATTEMPTS_PER_ROUND } from "./constants.ts";

/** The first attempt of the round after the one `attempt` is in. */
export function nextRound(attempt: number): number {
  return attempt - ((attempt - 1) % ATTEMPTS_PER_ROUND) + ATTEMPTS_PER_ROUND;
}

/** Whether `next`, the attempt after a release, starts a round: the one released was its round's last. */
export function roundSpent(next: number): boolean {
  return (next - 1) % ATTEMPTS_PER_ROUND === 0;
}
