// The audiences' limit from the environment (limits-env; README "Settings"), on the worktree's
// database: set to 3 before the module loads, a fourth audience, the default included, is
// icp_audience_limit with `details.limit` 3 and nothing written, while the third passes. Not an
// integer of 1 or more, the setting stops the module's load with config_invalid naming it, while a
// large value loads (limits-no-max), read in a process of its own, as signals' tests/runs.test.ts
// reads its settings; the api's start loads the module so (core/apps/api/src/modules.ts).
// tests/audiences.test.ts runs the default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, type Principal } from "@whytide/platform";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.ICP_MAX_AUDIENCES_PER_WORKSPACE = "3";
const { createAudience, listAudiences } = await import("../domain/commands.ts");
const { settings } = await import("../settings.ts");

withTestDb();

const member: Principal = {
  userId: "usr_member",
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_member",
  role: "Owner",
  scopes: [],
};
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: { ...member, workspaceId } }, fn, { client: asRole("app") });
const refusal = (error: unknown) =>
  isAppError(error) ? { code: error.code, status: error.status, details: error.details } : error;
const create = (workspaceId: string, name: string) =>
  run(workspaceId, () => createAudience({ name, createdBy: member.userId }));

test("set to 3: the default and two more pass; a fourth audience is icp_audience_limit with details.limit 3, nothing written", async () => {
  assert.equal(settings.ICP_MAX_AUDIENCES_PER_WORKSPACE, 3);
  const ws = "wsp_audiences_limits_env";
  await create(ws, "Second");
  await create(ws, "Third");
  assert.equal((await run(ws, () => listAudiences())).length, 3, "the default made first");
  assert.deepEqual(await create(ws, "Fourth").catch(refusal), {
    code: "icp_audience_limit",
    status: 409,
    details: { limit: 3 },
  });
  assert.equal(await run(ws, (tx) => tx.icp.count()), 3);
});

/** What a process with `env` set reads as the module loads: the limit, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify(settings.ICP_MAX_AUDIENCES_PER_WORKSPACE));",
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", PROVIDER_LLM: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("ICP_MAX_AUDIENCES_PER_WORKSPACE: an integer of 1 or more with no maximum, 10 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  const name = "ICP_MAX_AUDIENCES_PER_WORKSPACE";
  assert.equal(loaded({}), 10);
  assert.equal(loaded({ [name]: "" }), 10);
  assert.equal(loaded({ [name]: "1" }), 1);
  assert.equal(loaded({ [name]: "1000" }), 1000);
  const invalid = ["config_invalid", "modules/icp", [name]];
  for (const value of ["0", "-1", "1.5", "one"]) {
    assert.deepEqual(loaded({ [name]: value }), invalid, value);
  }
  // The api host loads the module's build: its index stops the same way.
  assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, "at load");
});
