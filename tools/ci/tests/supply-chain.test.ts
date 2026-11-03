// The end-to-end test of the supply-chain checks (alpha-p0-060), `pnpm -F ci test`, on a clone of
// the committed tree. The settings: an install whose lockfile does not match package.json fails in
// CI mode, and a version published inside the minimum release age is refused. The build scripts: a
// fixture dependency with a postinstall is refused and its script does not run, until its key is in
// allowBuilds. The scan: a commit that carries a fixture secret is rejected by the pre-commit hook,
// and secrets:scan fails on a branch that carries one. The review: deps:check passes on the tree and
// fails on a fixture dependency under GPL, on a known-vulnerable version and on two new dependencies
// at once, which the label dependency-update allows. The shapes: a schema field named password_hash
// outside the auth adapter's schema file, or session_cookie anywhere, fails secrets:scan. And
// SECURITY.md names the private channel and the triage time, linked from the README. The clone's
// pnpm talks to the registry and the scan runs Docker, as on any laptop.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ci, cloneOf, git, parse, run, say, tail } from "./harness.ts";

const here = import.meta.dirname;
const root = resolve(here, "..", "..", "..");
const fixtures = join(here, "..", "fixtures");
const failures: string[] = [];
const check = (ok: boolean, what: string): boolean => {
  if (!ok) failures.push(what);
  return ok;
};

checkDocuments();
checkClone();
if (failures.length) {
  for (const failure of failures) say(`FAIL ${failure}`);
  say(`${failures.length} failure${failures.length === 1 ? "" : "s"}`);
  process.exit(1);
}
say("ok: the supply-chain checks");
process.exit(0);

function checkDocuments(): void {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  for (const line of ["minimumReleaseAge: 10080", "strictDepBuilds: true", "allowBuilds:"]) {
    check(workspace.includes(line), `pnpm-workspace.yaml lacks ${line}`);
  }
  const security = readFileSync(join(root, "SECURITY.md"), "utf8");
  check(security.includes("security@whytide.com"), "SECURITY.md does not name the private channel");
  check(security.includes("2 business days"), "SECURITY.md does not name the triage time");
  check(
    readFileSync(join(root, "README.md"), "utf8").includes("](SECURITY.md)"),
    "README.md does not link SECURITY.md",
  );
}

function checkClone(): void {
  const { tmp, clone } = cloneOf(root);
  try {
    say(`== a clone of the committed tree in ${clone}`);
    const install = run(clone, "pnpm", ["install", "--frozen-lockfile"]);
    if (!check(install.status === 0, `the install in the clone:\n${tail(install.out)}`)) return;
    check(
      git(clone, ["config", "core.hooksPath"]).trim() === "tools/ci/hooks",
      "pnpm install did not install the pre-commit hook",
    );
    checkSettings(clone);
    checkBuildScripts(clone);
    checkScan(clone);
    checkReview(clone);
    checkShapes(clone);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Back to the committed tree and the lockfile's install, after a fixture changed them. */
function restore(clone: string): void {
  git(clone, ["checkout", "-q", "--", "."]);
  git(clone, ["clean", "-qfd"]);
  const install = run(clone, "pnpm", ["install", "--frozen-lockfile"]);
  if (install.status !== 0) throw new Error(`the install after a fixture:\n${tail(install.out)}`);
}

function checkSettings(clone: string): void {
  say("== an install whose lockfile does not match package.json, in CI mode");
  const manifest = join(clone, "package.json");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      '"typescript": "6.0.3"',
      '"typescript": "6.0.3",\n    "whytide-fixture-one": "file:tools/ci/fixtures/deps/one"',
    ),
  );
  const frozen = run(clone, "pnpm", ["install"], { CI: "true" });
  check(
    frozen.status !== 0 && /lockfile/i.test(frozen.out),
    `the mismatched install in CI mode: exit ${frozen.status}:\n${tail(frozen.out)}`,
  );
  restore(clone);

  say("== a version published inside the minimum release age");
  const times = JSON.parse(
    run(clone, "pnpm", ["view", "typescript", "time", "--json"]).stdout,
  ) as Record<string, string>;
  const young = Object.entries(times)
    .filter(
      ([version, at]) =>
        !["created", "modified"].includes(version) && Date.now() - Date.parse(at) < 7 * 86_400_000,
    )
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))[0];
  if (
    !check(young !== undefined, "no typescript version younger than 7 days on the registry to try")
  )
    return;
  const [version, at] = young ?? ["", ""];
  const add = run(clone, "pnpm", ["add", "-w", "-D", `typescript@${version}`]);
  check(
    add.status !== 0 && add.out.includes("minimumReleaseAge"),
    `typescript@${version}, published ${at}: exit ${add.status}:\n${tail(add.out)}`,
  );
  restore(clone);
}

function checkBuildScripts(clone: string): void {
  say("== a dependency with a build script");
  const spec = "file:tools/ci/fixtures/deps/postinstall";
  const marker = join(clone, "node_modules", "whytide-fixture-postinstall", "ran");
  const refused = run(clone, "pnpm", ["add", "-w", "-D", spec]);
  check(
    refused.status !== 0 && refused.out.includes("Ignored build scripts"),
    `the fixture with a postinstall: exit ${refused.status}:\n${tail(refused.out)}`,
  );
  check(!existsSync(marker), "the fixture's postinstall ran although it is not in allowBuilds");
  const workspace = join(clone, "pnpm-workspace.yaml");
  writeFileSync(
    workspace,
    readFileSync(workspace, "utf8").replace(
      /^allowBuilds:.*$/m,
      `allowBuilds:\n  "whytide-fixture-postinstall@${spec}": true`,
    ),
  );
  const allowed = run(clone, "pnpm", ["install"]);
  check(
    allowed.status === 0 && existsSync(marker),
    `the fixture once in allowBuilds: exit ${allowed.status}, ran ${existsSync(marker)}:\n${tail(allowed.out)}`,
  );
  restore(clone);
}

function checkScan(clone: string): void {
  say("== a commit that carries a fixture secret");
  copyFileSync(
    join(fixtures, "secrets", "anthropic.env"),
    join(clone, "core/packages/platform/keys.env"),
  );
  git(clone, ["add", "-A"]);
  const hook = run(clone, "git", ["commit", "-q", "-m", "fixture: a secret"]);
  check(
    hook.status !== 0 && hook.out.includes("secrets-scan: a secret is in the staged changes"),
    `the pre-commit hook: exit ${hook.status}:\n${tail(hook.out)}`,
  );
  say("== secrets:scan on a branch that carries it");
  git(clone, ["checkout", "-q", "-b", "fixture/secret"]);
  git(clone, ["commit", "-q", "--no-verify", "-m", "fixture: a secret"]);
  const scan = ci(clone, ["secrets:scan"]);
  check(
    scan.status === 1 &&
      parse(scan.out).get("secrets:scan") === "failed" &&
      scan.out.includes("whytide-anthropic-api-key"),
    `secrets:scan on the branch: exit ${scan.status}, ${parse(scan.out).get("secrets:scan")}:\n${tail(scan.out)}`,
  );
  git(clone, ["checkout", "-q", "main"]);
  git(clone, ["branch", "-q", "-D", "fixture/secret"]);
  const clean = ci(clone, ["secrets:scan"]);
  check(clean.status === 0, `secrets:scan on main: exit ${clean.status}:\n${tail(clean.out)}`);
}

function checkReview(clone: string): void {
  say("== deps:check on the tree");
  const tree = ci(clone, ["deps:check"]);
  check(tree.status === 0, `deps:check on the tree: exit ${tree.status}:\n${tail(tree.out)}`);
  const cases = [
    {
      what: "a dependency under GPL",
      add: ["file:tools/ci/fixtures/deps/gpl"],
      expect: "GPL-3.0-only",
    },
    { what: "a known-vulnerable version", add: ["minimist@1.2.5"], expect: "minimist critical" },
    {
      what: "two new dependencies",
      add: ["file:tools/ci/fixtures/deps/one", "file:tools/ci/fixtures/deps/two"],
      expect: "adds 2 dependencies",
    },
  ];
  for (const { what, add, expect } of cases) {
    say(`== deps:check with ${what}`);
    git(clone, ["checkout", "-q", "-b", "fixture/deps"]);
    const added = run(clone, "pnpm", ["add", "-w", "-D", ...add]);
    if (
      check(
        added.status === 0,
        `adding ${add.join(" ")}: exit ${added.status}:\n${tail(added.out)}`,
      )
    ) {
      const result = ci(clone, ["deps:check"]);
      check(
        result.status === 1 && result.out.includes(expect),
        `deps:check with ${what}: exit ${result.status}, no "${expect}":\n${tail(result.out)}`,
      );
      if (what === "two new dependencies") {
        const labelled = ci(clone, ["deps:check", "--labels", "dependency-update"]);
        check(
          labelled.status === 0,
          `deps:check with ${what} and the label: exit ${labelled.status}:\n${tail(labelled.out)}`,
        );
      }
    }
    restore(clone);
    git(clone, ["checkout", "-q", "main"]);
    git(clone, ["branch", "-q", "-D", "fixture/deps"]);
  }
}

function checkShapes(clone: string): void {
  const schema = join(clone, "core/packages/db/prisma/schema");
  mkdirSync(schema, { recursive: true });
  const cases = [
    {
      what: "password_hash outside the auth adapter's schema file",
      file: "leads.prisma",
      fixture: "password.prisma",
      expect: "password_hash looks like a password",
      exit: 1,
    },
    {
      what: "password_hash in the auth adapter's schema file",
      file: "auth.prisma",
      fixture: "auth.prisma",
      expect: "secret-shapes: ok",
      exit: 0,
    },
    {
      what: "session_cookie in the auth adapter's schema file",
      file: "auth.prisma",
      fixture: "cookie.prisma",
      expect: "session_cookie looks like a cookie",
      exit: 1,
    },
  ];
  for (const { what, file, fixture, expect, exit } of cases) {
    say(`== secrets:scan with ${what}`);
    copyFileSync(join(fixtures, "secret-shapes", fixture), join(schema, file));
    const result = ci(clone, ["secrets:scan"]);
    check(
      result.status === exit && result.out.includes(expect),
      `${what}: exit ${result.status}, no "${expect}":\n${tail(result.out)}`,
    );
    rmSync(join(schema, file), { recursive: true, force: true });
  }
}
