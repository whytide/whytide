// The prompts' evals (README.md "Evals"): each task passes its cases on the fake with the checks
// it sets; a copy of qualification's cases with one expected verdict changed, and the writer's scorer
// without its red-line gate, fail naming the case. No case or run file holds a real address, and a
// live run's record keeps no text (a real name is the reviewer's check). The pipeline's step runs the
// evals when an agent's or an eval's file changed since main, and only then.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";
import { evalsChanged } from "../evals/changes.ts";
import { type EvalReport, runRecord } from "../evals/runner.ts";

const pkg = join(import.meta.dirname, "..");
const evals = join(pkg, "evals");
mkdirSync(join(pkg, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(pkg, ".tmp", "evals-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const QUALIFY = "qualification.assess-fit";
const WRITE = "messaging.write-message";
const evalRun = (...args: string[]) =>
  spawnSync(process.execPath, ["evals/run.ts", ...args], {
    cwd: pkg,
    encoding: "utf8",
    env: { ...process.env, EVAL_LIVE: "0" },
  });
const scorerOf = (task: string) => pathToFileURL(join(evals, task, "score.ts")).href;

/** evals/<task>/ copied to a folder of its own, its cases changed by `edit`, its scorer `scorer`. */
function copyOf(task: string, scorer: string, edit?: (cases: Case[]) => void): string {
  const dir = mkdtempSync(join(tmp, "copy-"));
  const cases = JSON.parse(readFileSync(join(evals, task, "cases.json"), "utf8"));
  edit?.(cases);
  mkdirSync(join(dir, task));
  writeFileSync(join(dir, task, "cases.json"), JSON.stringify(cases));
  writeFileSync(join(dir, task, "score.ts"), scorer);
  return dir;
}
type Case = { name: string; expected: { verdicts: Record<string, string> } };

it("passes each task on the fake, each check over its cases at its threshold", () => {
  const suites = {
    "icp.draft-profile": { outcome: [2, 1], fails_safe: [1, 1], fields: [3, 0.8] },
    [QUALIFY]: { outcome: [23, 1], fails_safe: [7, 1], verdicts: [30, 0.8], anonymized: [5, 1] },
    [WRITE]: { outcome: [16, 1], fails_safe: [4, 1], length: [20, 1], grounding: [20, 0.9] },
    "onboarding.draft-company-knowledge": { outcome: [9, 1], fails_safe: [2, 1], sources: [10, 1] },
  };
  for (const [task, checks] of Object.entries(suites)) {
    const run = evalRun(task);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const [check, [cases, threshold]] of Object.entries(checks)) {
      const line = `^ {2}${check}: \\S+ over ${cases} cases, threshold ${threshold?.toFixed(2)}, pass`;
      assert.match(run.stdout, new RegExp(line, "m"), `${task}: ${check}`);
    }
  }
});

it("fails naming the case when a qualification case expects another verdict", () => {
  const dir = copyOf(QUALIFY, `export * from "${scorerOf(QUALIFY)}";\n`, (cases) => {
    const fit = cases.find((c) => c.name === "fleet-strong-fit");
    if (fit) fit.expected.verdicts.title_function = "not_met";
  });
  const run = evalRun(QUALIFY, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const failed =
    /^eval: failed: qualification\.assess-fit \(outcome 0\.96 under 1\.00: fleet-strong-fit\)$/m;
  assert.match(run.stdout, failed);
});

it("fails naming the injection case when the writer's red-line gate is removed", () => {
  const scorer = [
    `import * as scorer from "${scorerOf(WRITE)}";`,
    "export const { score, thresholds } = scorer;",
    "export const gates = scorer.gates.filter((gate) => gate !== scorer.redLinesGate);",
  ];
  const run = evalRun(WRITE, "--dir", copyOf(WRITE, `${scorer.join("\n")}\n`));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}injection-red-lines +ok +1 /m);
  const why =
    "fails_safe 0.75 under 1.00: injection-red-lines; red_lines 0.95 under 1.00: injection-red-lines";
  assert.match(
    run.stdout,
    new RegExp(`^eval: failed: messaging\\.write-message \\(${why}\\)$`, "m"),
  );
});

it("keeps real addresses out of the case and run files, and every text out of a run's record", () => {
  const files = readdirSync(evals, { recursive: true, encoding: "utf8" }).filter((file) =>
    /(?:^|\/)(?:cases|runs\/[^/]+)\.json$/.test(file),
  );
  assert.ok(files.length >= 5);
  const reserved = /(?:^|\.)(?:example|test|invalid|localhost)$|^example\.(?:com|net|org)$/;
  for (const file of files) {
    const text = readFileSync(join(evals, file), "utf8").toLowerCase();
    const hosts = [
      ...text.matchAll(/\bhttps?:\/\/([^\s"/?#:]+)/g),
      ...text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g),
      ...text.matchAll(/\b((?:[\w-]+\.)+(?:com|net|org|io|ai|co|eu|de|nl|be|fr|uk))\b/g),
    ].map((match) => match[1] ?? "");
    for (const host of hosts) assert.match(host, reserved, `${file}: ${host}`);
  }

  const failures = [{ attempt: 1, reason: "gates", issues: [{ path: "text", message: "TEXT-1" }] }];
  const outcome = {
    status: "ok",
    output: { text: "TEXT-2" },
    attempts: 2,
    calls: ["TEXT-3"],
    failures,
  };
  const cases = [
    { name: "texts", score: { outcome: 0 }, outcome },
    { name: "thrown", score: {}, error: "TEXT-4 in a message" },
    { name: "coded", score: {}, error: "ai_budget_exceeded" },
  ];
  const record = runRecord(
    { task: "a.b", checks: [], cases } as unknown as EvalReport,
    "2026-10-27",
  );
  assert.doesNotMatch(JSON.stringify(record), /TEXT-/);
  assert.deepEqual(
    record.cases.map((c) => c.result),
    ["ok", "error", "ai_budget_exceeded"],
  );
});

it("runs the step when a file under an agent's folder changed since main, and only then", () => {
  const repo = mkdtempSync(join(tmp, "repo-"));
  const identity = ["-c", "user.name=Eval Test", "-c", "user.email=eval@example.test"];
  const git = (...args: string[]) => {
    const run = spawnSync("git", [...identity, "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
  };
  const change = (file: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "a change\n");
  };
  const commit = (file: string) => {
    change(file);
    git("add", "-A");
    git("commit", "-q", "-m", file);
  };
  git("init", "-q", "-b", "main");
  commit("README.md");
  git("switch", "-q", "-c", "task");
  commit("core/modules/qualification/domain/assess/checks.ts");
  assert.equal(evalsChanged(repo), false);
  change("core/modules/qualification/agents/assess-fit/prompt.v1.md");
  assert.equal(evalsChanged(repo), true, "untracked");
  commit("core/modules/qualification/agents/assess-fit/prompt.v1.md");
  assert.equal(evalsChanged(repo), true, "committed");
});
