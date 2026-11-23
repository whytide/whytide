// The triage's check in code (agents/triage-engagers/README.md): decisionsGate, the agent task's
// gate, reads a valid output against its input and returns issues, never a text and never a change:
// each candidate decided exactly once, no index the input lacks, and a code exactly for a skip.
// callAgent retries a failure once, then records ai_failed. Pure.
import type { GateResult } from "@whytide/ai";
import type { TriageEngagersInput, TriageEngagersOutput } from "../../schemas/triage-engagers.ts";

export function decisionsGate(
  output: TriageEngagersOutput,
  input: TriageEngagersInput,
): GateResult {
  const issue = (message: string) => ({ path: "decisions", message });
  const issues = input.candidates.flatMap(({ index }) => {
    const decisions = output.decisions.filter((decision) => decision.index === index);
    const [only] = decisions;
    if (decisions.length !== 1 || only === undefined)
      return [issue(`candidate ${index}: ${decisions.length} decisions, one expected`)];
    const skip = only.decision === "skip";
    if (skip && only.code === null) return [issue(`candidate ${index}: a skip needs its code`)];
    return !skip && only.code !== null ? [issue(`candidate ${index}: a code only for a skip`)] : [];
  });
  const known = new Set(input.candidates.map(({ index }) => index));
  const unknown = output.decisions.filter(({ index }) => !known.has(index));
  const extra = unknown.map(({ index }) => issue(`candidate ${index}: not in the input`));
  return { gate: "decisions", issues: [...issues, ...extra] };
}
