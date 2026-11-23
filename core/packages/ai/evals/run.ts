// `pnpm -F ai eval [task]` (README.md "Evals"): the evals of a task, of every task of a module, or of
// all, on the LLM fake unless EVAL_LIVE=1; prints each task's table and exits 1 when one falls below
// its thresholds, naming the checks and the cases. Live, it writes each task's record to
// evals/<task>/runs/<date>.json. As the pipeline's step `eval` (tools/ci sets WHYTIDE_CI_LOCAL) with
// no task named, it runs only when a file under core/modules/*/agents/ or this package's evals/
// changed since the branch left main (changes.ts); otherwise it says so and passes. EVAL_LIVE=1 is
// refused there, before any call. `--cases <file>` (gamma-p7-065) adds inbox's reply golden set to
// inbox.classify-reply's cases, live only, from a file outside the repository: real replies are never
// committed, and the record keeps the golden cases' names and scores only.
//   node evals/run.ts [<task> | <module>] [--dir <folder>] [--cases <file>]
//   --dir: the evals' folder, this one by default; --cases: a golden file, with inbox.classify-reply
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { llmConfig } from "@whytide/providers";
import { loadAgentTasks } from "../registry/define.ts";
import { evalsChanged } from "./changes.ts";
import { evalConfig } from "./config.ts";
import { GOLDEN_TASK } from "./constants.ts";
import { goldenCases } from "./inbox.classify-reply/golden.ts";
import {
  type EvalCase,
  evalFolders,
  failureOf,
  formatReport,
  runEval,
  runRecord,
} from "./runner.ts";

const say = (text: string) => process.stdout.write(`${text}\n`);
const root = resolve(import.meta.dirname, "..", "..", "..", "..");

let select: string | undefined;
let dir = import.meta.dirname;
let casesFile: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "--dir") dir = resolve(args[++i] ?? usage("--dir needs a folder"));
  else if (arg === "--cases") casesFile = resolve(args[++i] ?? usage("--cases needs a file"));
  else if (arg.startsWith("-") || select !== undefined) usage(`unexpected argument ${arg}`);
  else select = arg;
}

const live = evalConfig.EVAL_LIVE === "1";
if (live && process.env.WHYTIDE_CI_LOCAL) usage("EVAL_LIVE=1 is refused in the pipeline");
if (process.env.WHYTIDE_CI_LOCAL && select === undefined && !evalsChanged(root)) {
  say("eval: skipped, nothing under core/modules/*/agents/ or core/packages/ai/evals/ changed");
  process.exit(0);
}
const golden = casesFile === undefined ? [] : readGolden(casesFile);
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
    const report = await runEval(dir, name, live, golden);
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

/**
 * The golden file's cases, refused unless live, for inbox.classify-reply alone, from a file outside
 * the repository. Its texts stay in memory; a broken line is named by its number only.
 */
function readGolden(file: string): EvalCase[] {
  if (!live)
    usage("--cases runs live only, with EVAL_LIVE=1: the fake has no answer for a real reply");
  if (select !== GOLDEN_TASK) usage(`--cases adds the reply golden set to ${GOLDEN_TASK} only`);
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    usage(`--cases: no file ${file}`);
  }
  const inRepository = relative(realpathSync(root), real);
  if (!isAbsolute(inRepository) && inRepository.split(sep)[0] !== "..") {
    usage("--cases: the file is inside the repository; keep real replies outside it");
  }
  try {
    return goldenCases(readFileSync(real, "utf8"));
  } catch (error) {
    usage(`--cases: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage(problem: string): never {
  process.stderr.write(
    `eval: ${problem}\nusage: pnpm -F ai eval [<task> | <module>] [--dir <folder>] [--cases <file>]\n`,
  );
  process.exit(2);
}
