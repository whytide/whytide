// The eval runner (README.md "Evals"; docs/rules/security.md §6: a changed prompt runs its evals). A
// folder evals/<task>/ holds a task's synthetic cases.json and its score.ts. Each case runs through
// callAgent's attempts (call/attempts.ts: the gates and the retry rule, no database), on the LLM fake
// scripted with the case's answers or, live, on PROVIDER_LLM's model; score.ts scores the outcome, and
// the task passes when each check's mean reaches its threshold. The scores stay in the printed report,
// and a live run's in its record (runRecord): nothing goes to the database or to Mastra's storage.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isAppError } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort, type PortInstance } from "@whytide/providers";
import { z } from "zod";
import { type AttemptFailure, runAttempts } from "../call/attempts.ts";
import { type AgentGate, type AgentTask, registeredAgentTasks } from "../registry/define.ts";
import { agentModel } from "../run/run-agent.ts";

const json = z.record(z.string(), z.unknown());
const caseSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase words joined by -"),
  input: json,
  fake: z.array(z.union([z.string(), json])).min(1),
  expected: z.unknown(),
});
const casesSchema = z
  .array(caseSchema)
  .min(1)
  .refine((cases) => new Set(cases.map((c) => c.name)).size === cases.length, "a name repeats");
const share = z.number().min(0).max(1);
const thresholdsSchema = z.record(z.string(), share).refine((t) => Object.keys(t).length > 0);
const scoreSchema = z.record(z.string(), z.union([z.boolean(), share]));

/**
 * A case of cases.json: `name` in the report; `input`, the task's, synthetic; `fake`, the fake model's
 * answers in order, the retry's after the first, a string as text and an object as its JSON (ignored
 * live); `expected`, what score.ts compares the outcome with.
 */
export type EvalCase = z.output<typeof caseSchema>;
/** How the case's call ended, as callAgent returns it, with every failed attempt. */
export type EvalOutcome = {
  readonly attempts: number;
  /** Each failed attempt, `{ attempt, reason, issues }`, gates included: the decision record's `gates`. */
  readonly failures: readonly AttemptFailure[];
  /** On the fake, what each model call received, `{ modelId, system, messages, tools }`; none live. */
  readonly calls?: readonly unknown[];
} & (
  | { readonly status: "ok"; readonly output: Record<string, unknown> }
  | { readonly status: "ai_failed"; readonly reason: string }
);
/** A case's checks by name: true or 1 passes, false or 0 fails, a share in between. */
export type EvalScore = Readonly<Record<string, boolean | number>>;
/** What evals/<task>/score.ts exports. */
export type EvalScorer = {
  readonly score: (evalCase: EvalCase, outcome: EvalOutcome) => EvalScore;
  /** Per check, the lowest mean, from 0 to 1, over the cases that report it. */
  readonly thresholds: Readonly<Record<string, number>>;
  /** A live run's thresholds, in place of `thresholds`; `thresholds` when absent. */
  readonly liveThresholds?: Readonly<Record<string, number>>;
  /** Run after the task's own gates on every attempt: a module's checks that run after the call. */
  readonly gates?: readonly AgentGate<z.ZodObject, z.ZodObject>[];
};

type CaseReport = {
  readonly name: string;
  readonly outcome?: EvalOutcome;
  readonly score: Readonly<Record<string, number>>;
  /** What stopped the case: an AppError's code, or a message. */
  readonly error?: string;
};
type CheckReport = {
  readonly check: string;
  readonly threshold: number;
  readonly mean: number;
  readonly cases: number;
  /** The cases that scored under 1 on the check. */
  readonly below: readonly string[];
  readonly pass: boolean;
};
export type EvalReport = {
  readonly task: string;
  readonly promptVersion: number;
  readonly vendor: string;
  readonly modelId: string;
  readonly cases: readonly CaseReport[];
  readonly checks: readonly CheckReport[];
  readonly pass: boolean;
};

/** The eval folders under `dir` that `select` names: one task, every task of a module, or all. */
export function evalFolders(dir: string, select?: string): string[] {
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  if (select === undefined) return names;
  return names.filter((name) => name === select || name.startsWith(`${select}.`));
}

/** Imports evals/<task>/score.ts, which may register its task, and checks what it exports. */
async function loadScorer(folder: string, name: string): Promise<EvalScorer> {
  const url = pathToFileURL(join(folder, "score.ts")).href;
  const module = (await import(url)) as Partial<EvalScorer>;
  const thresholds = thresholdsSchema.safeParse(module.thresholds);
  const live = thresholdsSchema.optional().safeParse(module.liveThresholds);
  if (typeof module.score !== "function" || !thresholds.success || !live.success) {
    throw new Error(`evals/${name}/score.ts: export score() and thresholds, each from 0 to 1`);
  }
  const { score, gates } = module;
  if (
    gates !== undefined &&
    !(Array.isArray(gates) && gates.every((g) => typeof g === "function"))
  ) {
    throw new Error(`evals/${name}/score.ts: gates is a list of functions`);
  }
  return { score, thresholds: thresholds.data, liveThresholds: live.data, gates };
}

function readCases(folder: string, name: string): EvalCase[] {
  const cases = casesSchema.safeParse(JSON.parse(readFileSync(join(folder, "cases.json"), "utf8")));
  if (!cases.success) throw new Error(`evals/${name}/cases.json: ${z.prettifyError(cases.error)}`);
  return cases.data;
}

/** One case: on `llm`, the fake scripted with its answers, or live on agentLlm(); the attempts, the score. */
async function runCase(
  task: AgentTask,
  evalCase: EvalCase,
  scorer: EvalScorer,
  llm: PortInstance<typeof llmPort> | undefined,
): Promise<CaseReport> {
  const { name } = evalCase;
  try {
    const fake = llm as LlmFake | undefined;
    fake?.reset();
    fake?.script(...evalCase.fake);
    const model = await agentModel(task, llm);
    const gates = [...(task.gates ?? []), ...(scorer.gates ?? [])];
    const { run, failures, count } = await runAttempts({ ...task, gates }, evalCase.input, model);
    const calls = fake?.recordedCalls.filter((c) => c.method === "model").map((c) => c.input);
    const ended = { attempts: count, failures, calls };
    const outcome: EvalOutcome = run.ok
      ? { status: "ok", output: run.output, ...ended }
      : { status: "ai_failed", reason: run.reason, ...ended };
    const scored = scoreSchema.parse(scorer.score(evalCase, outcome));
    const score = Object.fromEntries(Object.entries(scored).map(([k, v]) => [k, Number(v)]));
    return { name, outcome, score };
  } catch (error) {
    const reason = isAppError(error) ? error.code : String((error as Error)?.message ?? error);
    return { name, score: {}, error: reason.split("\n")[0] };
  }
}

function checkReport(check: string, threshold: number, cases: readonly CaseReport[]): CheckReport {
  const scored = cases.filter((c) => c.score[check] !== undefined);
  const values = scored.map((c) => c.score[check] ?? 0);
  const mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  const below = scored.filter((c) => (c.score[check] ?? 0) < 1).map((c) => c.name);
  // A rounding error never fails a mean that reaches its threshold.
  const pass = values.length > 0 && mean >= threshold - 1e-9;
  return { check, threshold, mean, cases: values.length, below, pass };
}

/** Runs evals/<name>/: every case, scored, then each check's mean against its threshold. */
export async function runEval(dir: string, name: string, live: boolean): Promise<EvalReport> {
  const folder = join(dir, name);
  const scorer = await loadScorer(folder, name);
  const task = registeredAgentTasks().get(name);
  if (!task) throw new Error(`evals/${name}: no agent task ${name} is registered`);
  const evalCases = readCases(folder, name);
  // Not live, the fake, whatever PROVIDER_LLM names: a case never reaches a model by mistake.
  const llm = live ? undefined : await getAdapter(llmPort, "fake");
  const { vendor, modelId } = await agentModel(task, llm);
  const cases: CaseReport[] = [];
  for (const evalCase of evalCases) cases.push(await runCase(task, evalCase, scorer, llm));
  const thresholds = Object.entries((live && scorer.liveThresholds) || scorer.thresholds);
  const checks = thresholds.map(([check, threshold]) => checkReport(check, threshold, cases));
  const pass = cases.every((c) => c.error === undefined) && checks.every((c) => c.pass);
  const { promptVersion } = task;
  return { task: name, promptVersion, vendor, modelId, cases, checks, pass };
}

/**
 * A live run's record, for evals/<task>/runs/<date>.json: the model, the checks and each case's
 * name, result and scores. No input, output or issue text, and an error only as its code.
 */
export function runRecord(report: EvalReport, date: string) {
  const { task, promptVersion, vendor, modelId, checks, pass } = report;
  const cases = report.cases.map((c) => ({
    name: c.name,
    result:
      c.error === undefined ? result(c) : /^[a-z][a-z0-9_]*$/.test(c.error) ? c.error : "error",
    attempts: c.outcome?.attempts ?? 0,
    score: c.score,
  }));
  return { task, date, vendor, modelId, promptVersion, pass, checks, cases };
}

/** Why a task failed: each check under its threshold with its cases below 1, and each case that threw. */
export function failureOf(report: EvalReport): string {
  const checks = report.checks
    .filter((c) => !c.pass)
    .map((c) =>
      c.cases === 0
        ? `${c.check}: no case reports it`
        : `${c.check} ${c.mean.toFixed(2)} under ${c.threshold.toFixed(2)}: ${c.below.join(", ")}`,
    );
  const thrown = report.cases.filter((c) => c.error !== undefined).map((c) => `${c.name} threw`);
  return [...checks, ...thrown].join("; ");
}

const cell = (value: number | undefined) =>
  value === undefined ? "-" : value === 1 ? "pass" : value === 0 ? "FAIL" : value.toFixed(2);

function result(c: CaseReport): string {
  if (c.error !== undefined) return `error: ${c.error}`;
  return c.outcome?.status === "ai_failed" ? `ai_failed ${c.outcome.reason}` : "ok";
}

/** The table: a row per case, then each check against its threshold, then the task's verdict. */
export function formatReport(report: EvalReport): string {
  const checks = [...new Set(report.cases.flatMap((c) => Object.keys(c.score)))];
  const rows = [
    ["case", "result", "attempts", ...checks],
    ...report.cases.map((c) => [
      c.name,
      result(c),
      String(c.outcome?.attempts ?? "-"),
      ...checks.map((check) => cell(c.score[check])),
    ]),
  ];
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  const lines = rows.map((row) =>
    `  ${row.map((text, i) => text.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd(),
  );
  for (const c of report.checks) {
    const verdict = `${c.mean.toFixed(2)} over ${c.cases} cases, threshold ${c.threshold.toFixed(2)}`;
    const below = c.below.length > 0 ? `; below 1: ${c.below.join(", ")}` : "";
    lines.push(`  ${c.check}: ${verdict}, ${c.pass ? "pass" : "FAIL"}${below}`);
  }
  lines.push(`${report.task}: ${report.pass ? "pass" : "FAIL"}`);
  return lines.join("\n");
}
