// `test:tenancy` (alpha-p1-020; docs/rules/security.md §3, docs/architecture.md §6). Part one, the
// schema: the tenancy fixtures under tests/fixtures/schema/tenancy/ (pass/ clean, each file of fail/
// exactly the rules expected.json lists) and the real schema folder clean. Part two, the isolation
// harness on the fixture tenant table, in this file's schema of the slice database: workspace B
// never reads workspace A's row, and the harness fails, as designed, on a read that omits
// workspace_id. A module registers its tenant tables the same way (README).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { packageRoot } from "../src/paths.ts";
import { formatSchemaFinding } from "../src/schema-lint.ts";
import { checkTenancyFolder } from "../src/tenancy-check.ts";
import { asRole, checkIsolation, isolationTest, withTestDb } from "../testing/index.ts";

const fixtures = join(packageRoot, "tests", "fixtures", "schema", "tenancy");
const TENANT_FIXTURE = "20261021000100_db_test_tenant_fixture";
const TABLE = "db_test_tenant_fixture";
withTestDb({ fixtures: [TENANT_FIXTURE] }); // once, at the top: this file's schema around its tests

test("the tenancy pass fixtures are clean", () => {
  assert.deepEqual(checkTenancyFolder(join(fixtures, "pass")).map(formatSchemaFinding), []);
});

test("every tenancy fail fixture produces exactly the rules expected.json lists", () => {
  const root = join(fixtures, "fail");
  const expected = JSON.parse(readFileSync(join(root, "expected.json"), "utf8")) as Record<
    string,
    readonly string[]
  >;
  const findings = checkTenancyFolder(root);
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
    assert.match(formatSchemaFinding(finding), /^\S+:\d+ [a-z-]+ \S/);
  }
});

test("the real schema folder has no tenancy finding", () => {
  const findings = checkTenancyFolder(join(packageRoot, "prisma", "schema"));
  assert.deepEqual(findings.map(formatSchemaFinding), []);
});

let rows = 0;
async function createRow(workspaceId: string): Promise<{ id: string }> {
  const id = `row_${++rows}_${workspaceId.slice(-8)}`;
  await asRole("app")
    .$executeRaw`INSERT INTO "db_test_tenant_fixture" ("id", "workspace_id", "note") VALUES (${id}, ${workspaceId}, 'isolation')`;
  return { id };
}

isolationTest(TABLE, {
  createRow,
  readAs: (workspaceId) =>
    asRole("app").$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "db_test_tenant_fixture" WHERE "workspace_id" = ${workspaceId}`,
});

test("the harness fails, as designed, on a read that omits workspace_id", async () => {
  await assert.rejects(
    checkIsolation(TABLE, {
      createRow,
      readAs: () =>
        asRole("app").$queryRaw<{ id: string }[]>`SELECT "id" FROM "db_test_tenant_fixture"`,
    }),
    /workspace B reads workspace A's row .* not scoped by workspace_id/,
  );
});
