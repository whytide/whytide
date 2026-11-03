// The attempts of one agent call (README.md "Calling an agent", "Gates"): runAgent, the task's gates
// on a valid answer, and the retry rule of docs/rules/security.md §6, a failed answer retried once with
// its failure in a data block, then ai_failed. callAgent records the outcome; the evals score it.
import type { z } from "zod";
import type { AgentTask } from "../registry/define.ts";
import {
  type AgentFailure,
  type AgentModel,
  type AgentRun,
  parseAgentInput,
  runAgent,
} from "../run/run-agent.ts";
import { checkGates } from "./gates.ts";

/** One attempt and one retry with the failure appended (docs/rules/security.md §6). */
export const MAX_ATTEMPTS = 2;

/** A failed attempt, as the decision record's `gates` and the retry's data block hold it. */
export type AttemptFailure = AgentFailure & { readonly attempt: number };

/** The retry decision: a passing answer is kept, a failing one retried up to MAX_ATTEMPTS, then ai_failed. */
export function nextStep(
  run: { readonly ok: boolean },
  attempt: number,
): "ok" | "retry" | "ai_failed" {
  if (run.ok) return "ok";
  return attempt < MAX_ATTEMPTS ? "retry" : "ai_failed";
}

/** The run, failed with reason `gates` when its valid output fails one of the task's gates. */
function gated<I extends z.ZodObject, O extends z.ZodObject>(
  task: AgentTask<I, O>,
  run: AgentRun<z.output<O>>,
  input: z.output<I>,
): AgentRun<z.output<O>> {
  if (!run.ok) return run;
  const failed = checkGates(task.gates ?? [], run.output, input);
  if (!failed) return run;
  const { output: _, ...rest } = run;
  return { ...rest, ok: false, ...failed };
}

/** runAgent until nextStep stops: the last run, every failed attempt, the model time, the count. */
export async function runAttempts<I extends z.ZodObject, O extends z.ZodObject>(
  task: AgentTask<I, O>,
  input: z.input<I>,
  model: AgentModel,
) {
  const parsed = parseAgentInput(task, input);
  const failures: AttemptFailure[] = [];
  let latencyMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const answer = await runAgent(task, input, { model, retry: failures.at(-1) });
    const run = gated(task, answer, parsed);
    latencyMs += run.latencyMs;
    if (!run.ok) failures.push({ attempt, reason: run.reason, issues: run.issues });
    if (nextStep(run, attempt) !== "retry") return { run, failures, latencyMs, count: attempt };
  }
}
