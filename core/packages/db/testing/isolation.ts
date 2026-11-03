// The two-workspace isolation harness (docs/rules/security.md §3, docs/rules/coding.md §11): a row in
// workspace A and one in workspace B, and the module's own scoped read for B never returns A's row.
// A module registers each tenant table with one isolationTest() call in a spec under its tests/,
// run by its `test:tenancy` script. `readAs` is the read the module's public queries make, scoped
// the way they are: the query inside `withTenant(…, { client: asRole("app") })` (src/tenant.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

export type IsolationSpec = {
  /** Inserts one row of the table in the workspace, the way the module's command does. */
  createRow(workspaceId: string): Promise<{ readonly id: string }>;
  /** Every row the module's public query returns in the workspace. */
  readAs(workspaceId: string): Promise<readonly { readonly id: string }[]>;
};

/** Registers the isolation test of `table` in the calling test file. */
export function isolationTest(table: string, spec: IsolationSpec): void {
  test(`two-workspace isolation: ${table}`, () => checkIsolation(table, spec));
}

/** What the test asserts; rejects when a read in one workspace sees another's row. */
export async function checkIsolation(table: string, spec: IsolationSpec): Promise<void> {
  const [a, b, c] = [workspaceId(), workspaceId(), workspaceId()] as [string, string, string];
  const rowA = await spec.createRow(a);
  const rowB = await spec.createRow(b);
  assert.notEqual(rowA.id, rowB.id, `${table}: two rows, two ids`);
  const seenByB = (await spec.readAs(b)).map((row) => row.id);
  assert.ok(seenByB.includes(rowB.id), `${table}: workspace B reads its own row`);
  assert.ok(
    !seenByB.includes(rowA.id),
    `${table}: workspace B reads workspace A's row ${rowA.id}: the query is not scoped by workspace_id`,
  );
  const seenByA = (await spec.readAs(a)).map((row) => row.id);
  assert.ok(seenByA.includes(rowA.id), `${table}: workspace A reads its own row`);
  assert.ok(!seenByA.includes(rowB.id), `${table}: workspace A reads workspace B's row ${rowB.id}`);
  assert.deepEqual(await spec.readAs(c), [], `${table}: an empty workspace reads nothing`);
}

function workspaceId(): string {
  return `wsp_test${randomBytes(8).toString("hex")}`;
}
