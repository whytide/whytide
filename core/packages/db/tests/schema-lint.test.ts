// The schema lint on its fixtures (alpha-p1-010): tests/fixtures/schema/pass/ must be clean and every
// file of tests/fixtures/schema/fail/ must produce exactly the rules expected.json lists for it, one
// entry per finding; then the real schema folder must be clean. Run with `pnpm -F db test`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { packageRoot } from "../src/paths.ts";
import { formatSchemaFinding, lintSchemaFolder } from "../src/schema-lint.ts";

const fixtures = join(packageRoot, "tests", "fixtures", "schema");

test("the pass fixtures are clean", () => {
  const findings = lintSchemaFolder(join(fixtures, "pass"));
  assert.deepEqual(findings.map(formatSchemaFinding), []);
});

test("every fail fixture produces exactly the rules expected.json lists", () => {
  const root = join(fixtures, "fail");
  const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8")) as Record<
    string,
    readonly string[]
  >;
  const findings = lintSchemaFolder(root);
  const actual = new Map<string, string[]>();
  for (const finding of findings) {
    const file = finding.path.slice(root.length + 1);
    actual.set(file, [...(actual.get(file) ?? []), finding.rule]);
  }
  for (const file of new Set([...Object.keys(expected), ...actual.keys()])) {
    assert.deepEqual(
      [...(actual.get(file) ?? [])].sort(),
      [...(expected[file] ?? [])].sort(),
      `${file}: ${findings
        .filter((f) => f.path.endsWith(`/${file}`))
        .map(formatSchemaFinding)
        .join("; ")}`,
    );
  }
  for (const finding of findings) {
    assert.match(
      formatSchemaFinding(finding),
      /^\S+:\d+ [a-z-]+ \S/,
      "a finding prints as path:line rule message",
    );
  }
});

test("the real schema folder is clean", () => {
  const findings = lintSchemaFolder(join(packageRoot, "prisma", "schema"));
  assert.deepEqual(findings.map(formatSchemaFinding), []);
});
