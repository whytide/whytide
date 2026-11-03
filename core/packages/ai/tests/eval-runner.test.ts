// The eval runner end to end (README.md "Evals"): `node evals/run.ts fixture`, which `pnpm -F ai eval
// fixture` runs after the build, passes the fixture task's cases on the fake and prints the table; a
// copy of the cases (--dir) with one expected output changed fails, naming the case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";

const pkg = join(import.meta.dirname, "..");
const fixture = join(pkg, "evals", "fixture.assess");
mkdirSync(join(pkg, ".tmp"), { recursive: true });
const copy = mkdtempSync(join(pkg, ".tmp", "evals-"));
after(() => rmSync(copy, { recursive: true, force: true }));

const evalRun = (...args: string[]) =>
  spawnSync(process.execPath, ["evals/run.ts", ...args], {
    cwd: pkg,
    encoding: "utf8",
    env: { ...process.env, EVAL_LIVE: "0" },
  });

it("passes the fixture task's cases, and fails naming the case whose expected output changed", () => {
  const passed = evalRun("fixture");
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /^== fixture\.assess, on the fake$/m);
  assert.match(passed.stdout, /^ {2}met-without-evidence +ai_failed gates +2 +pass$/m);
  assert.match(passed.stdout, /^ {2}outcome: 1\.00 over 4 cases, threshold 1\.00, pass$/m);

  const cases = JSON.parse(readFileSync(join(fixture, "cases.json"), "utf8"));
  cases[0].expected = { status: "ok", verdict: "not_met" };
  mkdirSync(join(copy, "fixture.assess"));
  writeFileSync(join(copy, "fixture.assess", "cases.json"), JSON.stringify(cases));
  const scorer = pathToFileURL(join(fixture, "score.ts")).href;
  writeFileSync(join(copy, "fixture.assess", "score.ts"), `export * from "${scorer}";\n`);
  const failed = evalRun("fixture", "--dir", copy);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /^ {2}hiring-signal +ok +1 +FAIL$/m);
  assert.match(failed.stdout, /^ {2}outcome: 0\.75 .*, FAIL; below 1: hiring-signal$/m);
  assert.match(
    failed.stdout,
    /^eval: failed: fixture\.assess \(outcome 0\.75 under 1\.00: hiring-signal\)$/m,
  );
});
