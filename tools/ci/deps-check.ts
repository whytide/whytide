// The dependency review, the step deps:check (docs/rules/delivery.md §4, security §7), in three
// parts: pnpm's audit against the registry's advisories, high and critical; every package's license
// in the allow-list of coding §10 or in license-exceptions.json with a reason; and, when the branch
// changes pnpm-lock.yaml, at most one new dependency, unless the merge request carries the label
// dependency-update. pnpm reads the lockfile and the store; nothing is installed for this.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { changedFiles, labels } from "./branch.ts";
import { sh } from "./workspace.ts";

type Advisory = {
  readonly module_name: string;
  readonly severity: string;
  readonly github_advisory_id: string;
  readonly vulnerable_versions: string;
};
type Audit = {
  readonly advisories?: Record<string, Advisory>;
  readonly metadata?: {
    readonly vulnerabilities?: Record<string, number>;
    readonly totalDependencies?: number;
  };
};
type Licensed = { readonly name: string; readonly versions: readonly string[] };
type Exception = { readonly name: string; readonly license: string; readonly reason: string };

const allowed = new Set([
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "PostgreSQL",
]);
const root = resolve(import.meta.dirname, "..", "..");
const say = (text: string) => process.stdout.write(`${text}\n`);
const problems: string[] = [];

audit();
licenses();
lockfile();
if (problems.length) {
  for (const problem of problems) say(`deps:check: ${problem}`);
  process.exit(1);
}
process.exit(0);

function pnpm(args: readonly string[]) {
  return spawnSync("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function audit(): void {
  const run = pnpm(["audit", "--audit-level=high", "--json"]);
  let report: Audit;
  try {
    report = JSON.parse(run.stdout ?? "") as Audit;
  } catch {
    problems.push(`the audit did not run: ${`${run.stderr ?? ""}${run.stdout ?? ""}`.trim()}`);
    return;
  }
  const counts = report.metadata?.vulnerabilities ?? {};
  const bad = (counts.high ?? 0) + (counts.critical ?? 0);
  if (bad > 0) {
    const found = Object.values(report.advisories ?? {})
      .filter((a) => a.severity === "high" || a.severity === "critical")
      .map(
        (a) => `${a.module_name} ${a.severity} ${a.github_advisory_id} (${a.vulnerable_versions})`,
      );
    problems.push(
      `audit: ${bad} high or critical advisor${bad === 1 ? "y" : "ies"}: ${found.join("; ")}`,
    );
    return;
  }
  say(
    `deps:check: audit ok, ${report.metadata?.totalDependencies ?? 0} packages, no high or critical advisory`,
  );
}

function licenses(): void {
  const run = pnpm(["licenses", "list", "--json"]);
  let byLicense: Record<string, Licensed[]> = {};
  try {
    byLicense = JSON.parse(run.stdout ?? "") as Record<string, Licensed[]>;
  } catch {
    if (run.status !== 0) {
      problems.push(
        `the license list did not run: ${`${run.stderr ?? ""}${run.stdout ?? ""}`.trim()}`,
      );
      return;
    }
  }
  const exceptions = JSON.parse(
    readFileSync(join(import.meta.dirname, "license-exceptions.json"), "utf8"),
  ) as Exception[];
  const unexplained = exceptions.filter((e) => !e.reason?.trim()).map((e) => e.name);
  if (unexplained.length) {
    problems.push(`license-exceptions.json: no reason given for ${unexplained.join(", ")}`);
  }
  let packages = 0;
  let excepted = 0;
  const bad: string[] = [];
  for (const [license, list] of Object.entries(byLicense)) {
    for (const pkg of list) {
      packages++;
      if (licenseAllowed(license)) continue;
      if (
        exceptions.some((e) => e.name === pkg.name && e.license === license && e.reason?.trim())
      ) {
        excepted++;
        continue;
      }
      bad.push(`${pkg.name}@${pkg.versions.join("/")} (${license})`);
    }
  }
  if (bad.length) {
    problems.push(
      `licenses: ${bad.join(", ")}: not MIT, BSD, Apache-2.0 or PostgreSQL (docs/rules/coding.md §10); an entry in tools/ci/license-exceptions.json needs a reason`,
    );
    return;
  }
  say(
    `deps:check: licenses ok, ${packages} packages, ${excepted} exception${excepted === 1 ? "" : "s"}`,
  );
}

/** An SPDX expression: one alternative of an OR, every part of an AND, in the allow-list. */
function licenseAllowed(expression: string): boolean {
  return expression
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .some((alternative) =>
      alternative.split(/\s+AND\s+/i).every((part) => allowed.has(part.trim())),
    );
}

function lockfile(): void {
  const { base, files } = changedFiles(root);
  if (!files.includes("pnpm-lock.yaml")) {
    say(`deps:check: pnpm-lock.yaml unchanged since ${base}`);
    return;
  }
  const mergeBase = sh(root, "git", ["merge-base", "HEAD", base]).trim();
  const before = spawnSync("git", ["show", `${mergeBase}:pnpm-lock.yaml`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const was = before.status === 0 ? dependencies(before.stdout ?? "") : new Set<string>();
  const now = dependencies(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
  const added = [...now].filter((name) => !was.has(name)).sort();
  if (added.length > 1 && !labels().includes("dependency-update")) {
    problems.push(
      `pnpm-lock.yaml adds ${added.length} dependencies since ${base} (${added.join(", ")}): one new dependency per merge request (docs/rules/coding.md §10), or the label dependency-update for the update bot`,
    );
    return;
  }
  say(
    `deps:check: pnpm-lock.yaml ${added.length ? `adds ${added.join(", ")}` : "adds no dependency"} since ${base}`,
  );
}

/** The direct dependencies of every importer in a lockfile, by name. */
function dependencies(lockfile: string): Set<string> {
  const names = new Set<string>();
  let importers = false;
  let inside = false;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) {
      importers = line.startsWith("importers:");
      continue;
    }
    if (!importers) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 4)
      inside = /^\s{4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(line);
    else if (indent === 6 && inside) {
      const name = /^\s{6}'?([^':]+)'?:\s*$/.exec(line)?.[1];
      if (name) names.add(name);
    }
  }
  return names;
}
