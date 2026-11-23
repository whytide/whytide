// The rating's check in code (agents/rate-engagement/README.md): ratingsGate, the agent task's gate,
// reads a valid output against its input and returns issues, never a text and never a change: each
// event rated exactly once, no index the input lacks, and a class exactly for an event with the
// person's words. callAgent retries a failure once, then records ai_failed. Pure.
import type { GateResult } from "@whytide/ai";
import type { RateEngagementInput, RateEngagementOutput } from "../../schemas/rate-engagement.ts";

export function ratingsGate(output: RateEngagementOutput, input: RateEngagementInput): GateResult {
  const issue = (message: string) => ({ path: "ratings", message });
  const issues = input.events.flatMap(({ index, words }) => {
    const ratings = output.ratings.filter((rating) => rating.index === index);
    if (ratings.length !== 1)
      return [issue(`event ${index}: ${ratings.length} ratings, one expected`)];
    const classed = ratings[0]?.intentClass !== null;
    if (classed && words === null) return [issue(`event ${index}: no words, so no class`)];
    return !classed && words !== null ? [issue(`event ${index}: a class expected`)] : [];
  });
  const known = new Set(input.events.map(({ index }) => index));
  const unknown = output.ratings.filter(({ index }) => !known.has(index));
  const extra = unknown.map(({ index }) => issue(`event ${index}: not in the input`));
  return { gate: "ratings", issues: [...issues, ...extra] };
}
