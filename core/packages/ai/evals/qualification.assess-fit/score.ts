// The assessment agent's scorer (core/modules/qualification/agents/assess-fit/README.md "Evals"). A
// case expects what a good model answers to its synthetic profile, so the cases run live as well; on
// the fake, scripted with that answer, some after an invalid first one, they test the blocks, the
// schema, the gate, the retry and the anonymization. `outcome` passes when the call ends ok with
// exactly the expected disqualifiers and verdicts, so a changed expected verdict fails its case; a
// fail-safe case (`failSafe`: an injection, or answers that fail twice) passes `fails_safe` so, or
// ai_failed. `verdicts` is the share of the expected verdicts given, 0 when ai_failed. `anonymized`,
// on the fake's recorded calls only, passes when none of the case's `forbidden` values reached the
// model. The runner's loadAgentTasks() registers the task.
import type { EvalCase, EvalOutcome, EvalScore } from "../runner.ts";

export const thresholds = { outcome: 1, fails_safe: 1, verdicts: 0.8, anonymized: 1 };
/** Live, every case answered with every expected verdict; there are no recorded calls to read. */
export const liveThresholds = { outcome: 1, fails_safe: 1, verdicts: 1 };

type Expected = {
  disqualifiers: string[];
  verdicts: Record<string, string>;
  failSafe?: boolean;
  forbidden?: string[];
};
type Output = { verdicts: { criterion: string; verdict: string }[]; disqualifiers: string[] };

export function score(evalCase: EvalCase, outcome: EvalOutcome): EvalScore {
  const expected = evalCase.expected as Expected;
  const wanted = Object.entries(expected.verdicts);
  let share = 0;
  let exact = false;
  if (outcome.status === "ok") {
    const output = outcome.output as Output;
    const given = new Map(output.verdicts.map((verdict) => [verdict.criterion, verdict.verdict]));
    const matched = wanted.filter(
      ([criterion, verdict]) => given.get(criterion) === verdict,
    ).length;
    share = wanted.length === 0 ? 1 : matched / wanted.length;
    const found = new Set(output.disqualifiers);
    const listed = new Set(expected.disqualifiers);
    exact = share === 1 && found.size === listed.size && [...found].every((c) => listed.has(c));
  }
  const scored: Record<string, boolean | number> = { verdicts: share };
  if (expected.failSafe) scored.fails_safe = exact || outcome.status === "ai_failed";
  else scored.outcome = exact;
  if (expected.forbidden !== undefined && outcome.calls !== undefined) {
    const sent = JSON.stringify(outcome.calls);
    scored.anonymized = !expected.forbidden.some((value) => sent.includes(value));
  }
  return scored;
}
