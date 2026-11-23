// The permission table the modules declare (gamma-p6-010; core/packages/platform/README.md
// "Principal and permissions"): every module loaded as the host loads them at start, from the list
// src/modules.generated.ts holds, and registeredPermissions() written one `action: Role, Role` line
// per action, sorted by action, compared with fixtures/permission-table.txt. The file is a review
// artifact, not a second source of truth: a merge request that adds an action or changes its roles
// updates it in the same change, so that the change shows in review. A failure names each line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { type RegisteredPermission, registeredPermissions } from "@whytide/platform";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules } from "../src/modules.ts";

/** The source tree's file, from dist/tests/, where the compiled test runs. */
const TABLE_FILE = resolve(import.meta.dirname, "../../tests/fixtures/permission-table.txt");
const UPDATE = "update tests/fixtures/permission-table.txt in the same merge request";

/** The table as the file holds it: `action: Role, Role` per action, by action; `none` for no role. */
function tableLines(table: ReadonlyMap<string, RegisteredPermission>): string[] {
  return [...table.keys()].sort().map((action) => {
    const roles = table.get(action)?.roles ?? [];
    return `${action}: ${roles.length ? roles.join(", ") : "none"}`;
  });
}

/** Each line the file and the declarations do not share, saying which side holds it; [] when equal. */
function differences(file: string, declared: readonly string[]): string[] {
  const lines = file.trimEnd().split("\n");
  const inFile = new Set(lines);
  const inCode = new Set(declared);
  const differ = [
    ...lines.filter((line) => !inCode.has(line)).map((line) => `- ${line} (the file only)`),
    ...declared.filter((line) => !inFile.has(line)).map((line) => `+ ${line} (declared only)`),
  ];
  if (differ.length === 0 && lines.join("\n") !== declared.join("\n")) {
    differ.push("the file's lines are not one per action, sorted by action");
  }
  return differ;
}

test("the roles every module declares are fixtures/permission-table.txt, line for line", async () => {
  await loadModules(moduleLoaders);
  const declared = tableLines(registeredPermissions());
  assert.ok(declared.length > 0, "no module registered an action");
  const differ = differences(readFileSync(TABLE_FILE, "utf8"), declared);
  assert.deepEqual(differ, [], `${UPDATE}:\n${differ.join("\n")}`);
});

test("a module whose roles change without the file fails the check, naming the line; so do an added action, a removed one and an unsorted file", async () => {
  await loadModules(moduleLoaders);
  const table = registeredPermissions();
  // The file as the declarations of now write it, against a module that changes one action.
  const file = `${tableLines(table).join("\n")}\n`;
  const action = [...table.keys()].sort()[0] ?? "";
  assert.ok(action, "no module registered an action");
  const { roles, source } = table.get(action) as RegisteredPermission;
  const changed = new Map(table);
  const other = roles.includes("Member")
    ? roles.filter((role) => role !== "Member")
    : [...roles, "Member" as const];
  changed.set(action, { roles: other, source });
  const said = (list: readonly string[]) => (list.length ? list.join(", ") : "none");
  assert.deepEqual(differences(file, tableLines(changed)), [
    `- ${action}: ${said(roles)} (the file only)`,
    `+ ${action}: ${said(other)} (declared only)`,
  ]);

  const added = new Map(table).set("roles_test.added", { roles: ["Owner"], source });
  assert.deepEqual(differences(file, tableLines(added)), [
    "+ roles_test.added: Owner (declared only)",
  ]);
  const removed = new Map(table);
  removed.delete(action);
  assert.deepEqual(differences(file, tableLines(removed)), [
    `- ${action}: ${said(roles)} (the file only)`,
  ]);
  const reversed = `${tableLines(table).reverse().join("\n")}\n`;
  assert.deepEqual(differences(reversed, tableLines(table)), [
    "the file's lines are not one per action, sorted by action",
  ]);
});
