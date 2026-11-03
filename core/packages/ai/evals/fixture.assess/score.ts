// The fixture task's scorer (README.md "Evals"): the runner's own example and test, on the fixture
// module of tests/fixtures/registry, whose task the import below registers. Its cases script the fake's
// answers, so it runs on the fake only. A case passes `outcome` when the call ends as expected: ok
// with the verdict, or ai_failed with the reason.
import "../../tests/fixtures/registry/modules/fixture/agents/assess/task.ts";
import { isDeepStrictEqual } from "node:util";
import type { EvalCase, EvalOutcome, EvalScore } from "../runner.ts";

export const thresholds = { outcome: 1 };

export function score(evalCase: EvalCase, outcome: EvalOutcome): EvalScore {
  const ended =
    outcome.status === "ok"
      ? { status: "ok", verdict: outcome.output.verdict }
      : { status: "ai_failed", reason: outcome.reason };
  return { outcome: isDeepStrictEqual(ended, evalCase.expected) };
}
