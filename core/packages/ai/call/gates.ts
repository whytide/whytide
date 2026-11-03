// The task's gates (README.md "Gates"; docs/rules/security.md §6, fail safe): its own checks, in code,
// of an output that passed its schema. Every gate runs, so that a retry hears of every failure at
// once; one failed gate makes the attempt a failed validation for the retry rule (attempts.ts).
import type { z } from "zod";
import type { AgentGate } from "../registry/define.ts";
import type { AgentFailure } from "../run/run-agent.ts";

/** The reason of an attempt whose output failed one of its task's gates. */
export const GATES_FAILED = "gates";

/** Every gate on the output: the issues of the failed ones, each named by its gate, or undefined. */
export function checkGates<I extends z.ZodObject, O extends z.ZodObject>(
  gates: readonly AgentGate<I, O>[],
  output: z.output<O>,
  input: z.output<I>,
): AgentFailure | undefined {
  const issues = gates.flatMap((gate) => {
    const result = gate(output, input);
    return result.issues.map((issue) => ({ gate: result.gate, ...issue }));
  });
  return issues.length > 0 ? { reason: GATES_FAILED, issues } : undefined;
}
