// The pipeline runner behind `pnpm ci:local` (docs/rules/delivery.md §4): the steps of steps.json in
// order, each as `pnpm -r --if-present <step>`, so a package joins a step by defining the script; a
// step names packages only through `only`, the folders it runs in and nowhere else. A step no package
// defines is reported as skipped. A package whose inputs have not changed since the step last passed
// on it is left out of the run (README.md, "The cache"). A step marked serial in steps.json runs one
// package at a time.
// The first failing step stops the run and is named; the exit code is then 1.
//   node tools/ci/ci.ts [step...] [--labels <a,b>] [--no-cache]
// The GitLab job runs the same command one step at a time (.gitlab-ci.yml, gitlab.sh).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Inputs, type Step, stepPackages, workspacePackages } from "./workspace.ts";

type Status = "ok" | "cached" | "skipped" | "failed" | "not run";
type Result = {
  readonly step: string;
  readonly status: Status;
  readonly ms: number;
  readonly note: string;
};
type Passed = { readonly hash: string; readonly at: string; readonly ms: number };

const root = resolve(import.meta.dirname, "..", "..");
const cacheDir = join(root, "node_modules", ".cache", "whytide-ci");
const allSteps = JSON.parse(
  readFileSync(join(import.meta.dirname, "steps.json"), "utf8"),
) as Step[];
const say = (text: string) => process.stdout.write(`${text}\n`);

const wanted: string[] = [];
let labels: string | undefined;
let useCache = true;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--labels") labels = args[++i] ?? usage("--labels needs a value");
  else if (arg.startsWith("--labels=")) labels = arg.slice("--labels=".length);
  else if (arg === "--no-cache") useCache = false;
  else if (arg.startsWith("-")) usage(`unknown option ${arg}`);
  else if (allSteps.some((step) => step.name === arg)) wanted.push(arg);
  else usage(`unknown step ${arg}`);
}
const steps = wanted.length ? allSteps.filter((step) => wanted.includes(step.name)) : allSteps;
const env: Record<string, string | undefined> = { ...process.env, WHYTIDE_CI_LOCAL: "1" };
if (labels !== undefined) env.CI_MERGE_REQUEST_LABELS = labels;

const packages = workspacePackages(root);
const inputs = new Inputs(root, packages);
const results: Result[] = [];
const started = Date.now();
let failed: string | undefined;

for (const step of steps) {
  if (failed) {
    results.push({ step: step.name, status: "not run", ms: 0, note: "" });
    continue;
  }
  const defining = stepPackages(step, packages);
  if (defining.length === 0) {
    say(`== ${step.name}: skipped, no package defines it`);
    results.push({ step: step.name, status: "skipped", ms: 0, note: "no package defines it" });
    continue;
  }
  const cacheable = useCache && step.cache !== false;
  const records = cacheable ? readRecords(step.name) : {};
  const hashes = new Map(
    defining.map((p) => [p.name, cacheable ? inputs.hashFor(step.name, p) : ""]),
  );
  const cached = defining.filter((p) => cacheable && records[p.name]?.hash === hashes.get(p.name));
  const toRun = defining.filter((p) => !cached.includes(p));
  const note = `${count(toRun.length, "package")}${cached.length ? `, ${cached.length} cached` : ""}`;
  if (toRun.length === 0) {
    say(`== ${step.name}: cached for ${count(defining.length, "package")}`);
    results.push({ step: step.name, status: "cached", ms: 0, note: `${defining.length} cached` });
    continue;
  }
  say(`== ${step.name}: ${note}`);
  const t = Date.now();
  const run = spawnSync(
    "pnpm",
    [
      "-r",
      "--if-present",
      ...(step.serial ? ["--workspace-concurrency=1"] : []),
      ...(step.only
        ? toRun.flatMap((p) => ["--filter", p.name])
        : cached.flatMap((p) => ["--filter", `!${p.name}`])),
      step.name,
    ],
    { cwd: root, env, stdio: "inherit", encoding: "utf8" },
  );
  const ms = Date.now() - t;
  if (run.status === 0) {
    if (cacheable) {
      const at = new Date().toISOString();
      for (const p of toRun) records[p.name] = { hash: hashes.get(p.name) ?? "", at, ms };
      writeRecords(step.name, records);
    }
    results.push({ step: step.name, status: "ok", ms, note });
  } else {
    failed = step.name;
    const why = run.error ? run.error.message : `exit ${run.status ?? run.signal}`;
    results.push({ step: step.name, status: "failed", ms, note: why });
  }
}

say("");
const width = Math.max(...results.map((r) => r.step.length));
for (const r of results) {
  const time = r.ms ? duration(r.ms) : "";
  say(`  ${r.step.padEnd(width)}  ${r.status.padEnd(7)}  ${time.padStart(6)}  ${r.note}`.trimEnd());
}
const total = duration(Date.now() - started);
say(failed ? `ci:local: failed at ${failed} after ${total}` : `ci:local: ok in ${total}`);
process.exit(failed ? 1 : 0);

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function recordFile(step: string): string {
  return join(cacheDir, `${step.replaceAll(":", "-")}.json`);
}

function readRecords(step: string): Record<string, Passed | undefined> {
  const file = recordFile(step);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Passed>) : {};
}

function writeRecords(step: string, records: Record<string, Passed | undefined>): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(recordFile(step), `${JSON.stringify(records, null, 2)}\n`);
}

function usage(problem: string): never {
  process.stderr.write(
    `ci:local: ${problem}\nusage: pnpm ci:local [step...] [--labels <a,b>] [--no-cache]\nsteps: ${allSteps.map((s) => s.name).join(", ")}\n`,
  );
  process.exit(2);
}
