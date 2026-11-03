// `pnpm -F ai eval [task]` (README.md "Evals"): the evals of a task, of every task of a module, or of
// all, on the LLM fake unless EVAL_LIVE=1; prints each task's table and exits 1 when one falls below
// its thresholds, naming the checks and the cases. Live, it writes each task's record to
// evals/<task>/runs/<date>.json. As the pipeline's step `eval` (tools/ci sets WHYTIDE_CI_LOCAL) with
// no task named, it runs only when a file under core/modules/*/agents/ or this package's evals/
// changed since the branch left main (changes.ts); otherwise it says so and passes.
//   node evals/run.ts [<task> | <module>] [--dir <folder>]    --dir: the evals' folder, this one by default
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { llmConfig } from "@whytide/providers";
import { loadAgentTasks } from "../registry/define.ts";
import { evalsChanged } from "./changes.ts";
import { evalConfig } from "./config.ts";
import { evalFolders, failureOf, formatReport, runEval, runRecord } from "./runner.ts";

const say = (text: string) => process.stdout.write(`${text}\n`);
const root = resolve(import.meta.dirname, "..", "..", "..", "..");

let select: string | undefined;
let dir = import.meta.dirname;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--dir") dir = resolve(args[++i] ?? usage("--dir needs a folder"));
  else if (arg.startsWith("-") || select !== undefined) usage(`unexpected argument ${arg}`);
  else select = arg;
}

if (process.env.WHYTIDE_CI_LOCAL && select === undefined && !evalsChanged(root)) {
  say("eval: skipped, nothing under core/modules/*/agents/ or core/packages/ai/evals/ changed");
  process.exit(0);
}
const live = evalConfig.EVAL_LIVE === "1";
if (live && (llmConfig.PROVIDER_LLM ?? "fake") === "fake") {
  usage("EVAL_LIVE=1 runs on the model of PROVIDER_LLM: name a vendor's adapter, its key set");
}
const folders = evalFolders(dir, select);
if (folders.length === 0) usage(`no eval folder ${select ? `for ${select} ` : ""}under ${dir}`);

// The modules' task files import @whytide/ai, this package's dist, while the runner runs its sources:
// two copies would register aiErrors twice and keep two task registries. The task files get the
// sources too, so that they register in the registry runEval reads.
const sources = pathToFileURL(resolve(import.meta.dirname, "..", "index.ts")).href;
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier === "@whytide/ai"
      ? { url: sources, shortCircuit: true }
      : nextResolve(specifier, context),
});
await loadAgentTasks();
const failed: string[] = [];
for (const name of folders) {
  say(`== ${name}, on ${live ? `${llmConfig.PROVIDER_LLM}, live` : "the fake"}`);
  try {
    const report = await runEval(dir, name, live);
    say(formatReport(report));
    if (!report.pass) failed.push(`${name} (${failureOf(report)})`);
    if (live) {
      const date = new Date().toISOString().slice(0, 10);
      const file = join(dir, name, "runs", `${date}.json`);
      mkdirSync(join(dir, name, "runs"), { recursive: true });
      writeFileSync(file, `${JSON.stringify(runRecord(report, date), null, 2)}\n`);
      say(`eval: the run's record is ${relative(root, file)}`);
    }
  } catch (error) {
    say(`${name}: FAIL, ${error instanceof Error ? error.message : String(error)}`);
    failed.push(name);
  }
}
const tasks = `${folders.length} task${folders.length === 1 ? "" : "s"}`;
say(failed.length ? `eval: failed: ${failed.join(", ")}` : `eval: ok, ${tasks} passed`);
process.exit(failed.length ? 1 : 0);

function usage(problem: string): never {
  process.stderr.write(
    `eval: ${problem}\nusage: pnpm -F ai eval [<task> | <module>] [--dir <folder>]\n`,
  );
  process.exit(2);
}
