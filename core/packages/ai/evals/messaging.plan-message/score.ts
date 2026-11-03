// The planner's scorer (core/modules/messaging/agents/plan-message/README.md "Evals"). A case expects
// what a good model plans for its synthetic lead, so the cases run live as well; on the fake,
// scripted with that plan, they test the blocks and the schema. `outcome` passes when the call ends
// ok citing only the facts of the case's blocks (the facts_used gate's rule); `angle`, when the plan
// takes the expected angle. The thresholds are alpha's; alpha-p10-050 sets them from live runs.
import type { EvalCase, EvalOutcome, EvalScore } from "../runner.ts";

export const thresholds = { outcome: 1, angle: 0.8 };

/** The fact ids of a block: the keys of its `{ "f_3": "…" }` maps, at any depth. */
function factIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(factIds);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    /^f_[1-9][0-9]*$/.test(key) ? [key] : factIds(item),
  );
}

export function score(evalCase: EvalCase, outcome: EvalOutcome): EvalScore {
  if (outcome.status !== "ok") return { outcome: false, angle: 0 };
  const plan = outcome.output as { angle: string; factIds: string[] };
  const known = new Set(factIds(evalCase.input));
  const { angle } = evalCase.expected as { angle: string };
  return { outcome: plan.factIds.every((id) => known.has(id)), angle: plan.angle === angle };
}
