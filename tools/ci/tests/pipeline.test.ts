// The end-to-end test of the pipeline (alpha-p0-050), `pnpm -F ci test`. First the pipeline file:
// the workflow rules of .gitlab-ci.yml allow only web, trigger and api, every image and include is
// pinned by digest, and its script lines are the steps of steps.json in the same order; and a step's
// `only` folders define its script, since a step no package runs is skipped and passes. Then the
// runs, on a clone of the committed tree so uncommitted work is not tested: `pnpm ci:local` on the
// skeleton runs every step, reports the undefined ones as skipped and exits 0; a second run comes
// from the cache in under a quarter of the time; a fixture branch with a lint failure exits 1 naming
// the step; a fixture branch that changes a module without its docs fails docs:check until the label
// docs-not-needed, then changeset:check until a changeset or the label no-changeset. Inside a
// `pnpm ci:local` run (WHYTIDE_CI_LOCAL is set) only the first part runs: the run that is proving
// this package cannot start another full run from its own test step.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Step, stepPackages, workspacePackages } from "../workspace.ts";
import { ci, cloneOf, commit, git, parse, run, say, tail } from "./harness.ts";

const here = import.meta.dirname;
const root = resolve(here, "..", "..", "..");
const steps = JSON.parse(readFileSync(join(here, "..", "steps.json"), "utf8")) as Step[];
const names = steps.map((step) => step.name);
const failures: string[] = [];
const check = (ok: boolean, what: string): boolean => {
  if (!ok) failures.push(what);
  return ok;
};

checkPipelineFile();
checkOnly();
if (process.env.WHYTIDE_CI_LOCAL) {
  say("inside pnpm ci:local: the runs are proven by the outer invocation, pnpm -F ci test");
} else {
  checkRuns();
}
if (failures.length) {
  for (const failure of failures) say(`FAIL ${failure}`);
  say(`${failures.length} failure${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}
say("ok: the pipeline file and the runs");
process.exit(0);

function checkPipelineFile(): void {
  const text = readFileSync(join(root, ".gitlab-ci.yml"), "utf8");
  const lines = text.split("\n");

  // Pipelines only from the web UI, a trigger token or the API: every workflow rule is an `if` on
  // CI_PIPELINE_SOURCE whose every clause names one of those three.
  const rules = block(lines, "workflow:").filter((line) => /^\s*- /.test(line));
  check(rules.length > 0, "workflow: has no rules");
  for (const rule of rules) {
    const condition = /^\s*- if:\s*(.+?)\s*$/.exec(rule)?.[1];
    if (!condition) {
      check(false, `a workflow rule that is not an if: ${rule.trim()}`);
      continue;
    }
    const sources = [...condition.matchAll(/\$CI_PIPELINE_SOURCE\s*==\s*"([a-z_]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    const allowed = sources.every((source) => ["web", "trigger", "api"].includes(source));
    check(
      sources.length === condition.split("||").length && allowed,
      `a workflow rule allows more than web, trigger and api: ${condition}`,
    );
  }

  // Every image, the services' and the *_IMAGE variables' included, pinned by digest.
  const images = [...text.matchAll(/^\s*(?:image|- name|[A-Z_]+_IMAGE):\s*"?([^\s"#]+)/gm)].map(
    (match) => match[1] ?? "",
  );
  check(images.length > 0, "no image in .gitlab-ci.yml");
  for (const image of images) {
    check(/@sha256:[0-9a-f]{64}$/.test(image), `${image} is not pinned by digest`);
  }

  // Every include pinned: a project include by a commit, a component by a digest; a local one is
  // pinned by the commit itself; a remote or template include cannot be pinned.
  const entries: string[][] = [];
  for (const line of block(lines, "include:")) {
    if (/^\s*- /.test(line)) entries.push([]);
    entries[entries.length - 1]?.push(line.replace(/^\s*- /, "  "));
  }
  for (const entry of entries) {
    const text = entry.join("\n");
    const pinned =
      /^\s*local:/m.test(text) ||
      /^\s*component:\s*\S+@sha256:[0-9a-f]{64}\s*$/m.test(text) ||
      (/^\s*project:/m.test(text) && /^\s*ref:\s*"?[0-9a-f]{40}"?\s*$/m.test(text));
    check(pinned, `an include that is not pinned by digest:\n${text}`);
  }

  // The script runs the steps of steps.json, every one, in the same order.
  const scripted = [...text.matchAll(/^\s*- sh tools\/ci\/gitlab\.sh step (\S+)\s*$/gm)].map(
    (match) => match[1] ?? "",
  );
  check(
    scripted.join(" ") === names.join(" "),
    `the script runs [${scripted.join(", ")}]; steps.json lists [${names.join(", ")}]`,
  );
  say(
    `checked .gitlab-ci.yml: ${rules.length} workflow rules, ${images.length} images, ${entries.length} includes, ${scripted.length} steps`,
  );
}

/** Every folder a step's `only` names defines the step's script: smoke's deploy, today. */
function checkOnly(): void {
  const packages = workspacePackages(root);
  const limited = steps.filter((step) => step.only !== undefined);
  for (const step of limited) {
    for (const dir of step.only ?? []) {
      const pkg = packages.find((p) => p.dir === dir);
      check(
        pkg !== undefined && step.name in pkg.scripts,
        `${step.name} runs only in ${dir}, which does not define it`,
      );
    }
  }
  say(
    `checked steps.json: ${limited.map((step) => `${step.name} in ${step.only?.join(", ")}`).join("; ")}`,
  );
}

/** The lines of a top-level YAML block, from after its key to the next top-level key. */
function block(lines: readonly string[], key: string): string[] {
  const start = lines.indexOf(key);
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    body.push(line);
  }
  return body;
}

function checkRuns(): void {
  const { tmp, clone } = cloneOf(root);
  try {
    say(`== a clone of the committed tree in ${clone}`);
    const install = run(clone, "pnpm", ["install", "--frozen-lockfile"]);
    if (!check(install.status === 0, `the install in the clone:\n${tail(install.out)}`)) return;
    const listed = workspacePackages(clone);
    const defined = new Set(
      steps.filter((step) => stepPackages(step, listed).length > 0).map((step) => step.name),
    );
    const cached = new Set(steps.filter((step) => step.cache !== false).map((step) => step.name));

    say("== pnpm ci:local on the skeleton");
    const first = ci(clone, []);
    check(first.status === 0, `the first run exited ${first.status}:\n${tail(first.out)}`);
    check(first.out.includes("ci:local: ok in"), "the first run does not end with ci:local: ok");
    const report = parse(first.out);
    for (const name of names) {
      const want = defined.has(name) ? "ok" : "skipped";
      check(
        report.get(name) === want,
        `${name} is ${report.get(name)} on the first run, not ${want}`,
      );
    }

    say("== a second run, from the cache");
    const second = ci(clone, []);
    check(second.status === 0, `the second run exited ${second.status}:\n${tail(second.out)}`);
    const again = parse(second.out);
    for (const name of names) {
      const want = !defined.has(name) ? "skipped" : cached.has(name) ? "cached" : "ok";
      check(
        again.get(name) === want,
        `${name} is ${again.get(name)} on the second run, not ${want}`,
      );
    }
    check(
      second.ms * 4 < first.ms,
      `the second run took ${second.ms} ms, the first ${first.ms} ms: not under a quarter`,
    );

    say("== a fixture branch with a lint failure");
    git(clone, ["checkout", "-q", "-b", "fixture/lint"]);
    writeFileSync(
      join(clone, "core/packages/platform/later.ts"),
      "// TODO without the task that will do it\nexport const later = true;\n",
    );
    commit(clone, "fixture: a TODO without a task");
    const lint = ci(clone, []);
    check(lint.status === 1, `the lint fixture exited ${lint.status}, not 1:\n${tail(lint.out)}`);
    check(
      lint.out.includes("ci:local: failed at lint"),
      "the lint fixture's run does not name lint",
    );
    const lintReport = parse(lint.out);
    check(
      lintReport.get("lint") === "failed" && lintReport.get("typecheck") === "not run",
      `the lint fixture's report: lint ${lintReport.get("lint")}, typecheck ${lintReport.get("typecheck")}`,
    );

    say("== a fixture branch that changes a module without its docs");
    git(clone, ["checkout", "-q", "main"]);
    git(clone, ["checkout", "-q", "-b", "fixture/docs"]);
    mkdirSync(join(clone, "core/modules/x/api"), { recursive: true });
    writeFileSync(join(clone, "core/modules/x/api/a.ts"), "export const a = 1;\n");
    commit(clone, "fixture: a module changed without its docs");
    const docs = ci(clone, []);
    check(
      docs.status === 1 && parse(docs.out).get("docs:check") === "failed",
      `without the label: exit ${docs.status}, docs:check ${parse(docs.out).get("docs:check")}`,
    );
    const labelled = ci(clone, ["--labels", "docs-not-needed"]);
    const labelledReport = parse(labelled.out);
    check(
      labelled.status === 1 &&
        labelledReport.get("docs:check") === "ok" &&
        labelledReport.get("changeset:check") === "failed",
      `with docs-not-needed and no changeset: exit ${labelled.status}, docs:check ${labelledReport.get("docs:check")}, changeset:check ${labelledReport.get("changeset:check")}`,
    );
    const both = ci(clone, ["--labels", "docs-not-needed,no-changeset"]);
    check(both.status === 0, `with both labels: exit ${both.status}:\n${tail(both.out)}`);
    writeFileSync(join(clone, ".changeset/fixture.md"), "---\n---\n\nfixture\n");
    const changeset = ci(clone, ["--labels", "docs-not-needed"]);
    check(
      changeset.status === 0 && parse(changeset.out).get("changeset:check") === "ok",
      `with an untracked changeset: exit ${changeset.status}, changeset:check ${parse(changeset.out).get("changeset:check")}`,
    );
    writeFileSync(join(clone, "core/modules/x/README.md"), "# x\n");
    const documented = ci(clone, []);
    check(
      documented.status === 0 && parse(documented.out).get("docs:check") === "ok",
      `with the README: exit ${documented.status}, docs:check ${parse(documented.out).get("docs:check")}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
