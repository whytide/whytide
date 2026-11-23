// The limits from the environment (limits-env; README "Settings"), on the worktree's database: set
// to 4 agents and 2 sources before the module loads, the commands refuse a fifth live agent and a
// third source, each with its code and `details.limit` the value set, while the fourth agent and
// two sources pass. Not an integer of 1 or more, a setting stops the module's load with
// config_invalid naming it, while a large value loads (limits-no-max), read in a process of its
// own, as signals' tests/runs.test.ts reads its settings; the api's start loads the module so
// (core/apps/api/src/modules.ts). tests/playbooks.test.ts runs the defaults.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { ids as icpIds } from "@whytide/icp";
import { isAppError, newId, type Principal } from "@whytide/platform";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE = "4";
process.env.PLAYBOOKS_MAX_SOURCES_PER_AGENT = "2";
const { createPlaybook, setSources, sourcesOf } = await import("../domain/playbooks.ts");
const { settings } = await import("../settings.ts");
const { useSourceChecker } = await import("../testing/index.ts");

withTestDb();

const OWNER = "usr_owner";
const member: Principal = {
  userId: OWNER,
  actorType: "human",
  authMethod: "session",
  membershipId: "mem_owner",
  role: "Member",
  scopes: [],
};
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: { ...member, workspaceId } }, fn, { client: asRole("app") });
const refusal = (error: unknown) =>
  isAppError(error) ? { code: error.code, status: error.status, details: error.details } : error;

/** An audience of the workspace, as icp's createAudience leaves one. */
async function audience(workspaceId: string, name: string): Promise<string> {
  const id = newId(icpIds.icp);
  await asRole("app").icp.create({ data: { id, workspaceId, name, isDefault: false } });
  return id;
}
const create = (workspaceId: string, icpId: string) =>
  run(workspaceId, () => createPlaybook({ name: "Agent", icpId, ownerUserId: OWNER }));

const SOURCES = ["src_a", "src_b", "src_c"];
after(
  useSourceChecker(async (sourceIds) =>
    sourceIds.map((sourceId) => ({
      sourceId,
      found: true,
      readingAccountId: "sac_owner",
      readingOwnerUserId: OWNER,
    })),
  ),
);

test("set to 4 agents and 2 sources: the fifth live agent is playbook_limit_reached and a third source playbook_sources_limit, each with details.limit the value set and nothing written; the fourth agent and two sources pass", async () => {
  const configured = [
    settings.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE,
    settings.PLAYBOOKS_MAX_SOURCES_PER_AGENT,
  ];
  assert.deepEqual(configured, [4, 2]);
  const ws = "wsp_limits_env";
  const agents = [];
  for (let at = 1; at <= 4; at++) agents.push(await create(ws, await audience(ws, `A${at}`)));
  const fifth = await audience(ws, "Fifth");
  assert.deepEqual(await create(ws, fifth).catch(refusal), {
    code: "playbook_limit_reached",
    status: 409,
    details: { limit: 4 },
  });
  assert.equal(await asRole("app").playbook.count({ where: { workspaceId: ws } }), 4);

  const [first] = agents;
  assert.ok(first);
  const two = SOURCES.slice(0, 2);
  assert.deepEqual(await run(ws, () => setSources(first.id, two)), two);
  assert.deepEqual(await run(ws, () => setSources(first.id, SOURCES)).catch(refusal), {
    code: "playbook_sources_limit",
    status: 400,
    details: { limit: 2 },
  });
  assert.deepEqual(await run(ws, () => sourcesOf(first.id)), two, "nothing written");
});

/** What a process with `env` set reads as the module loads: the two limits, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify([settings.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE, settings.PLAYBOOKS_MAX_SOURCES_PER_AGENT]));",
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

test("each limit is an integer of 1 or more with no maximum, its default unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.deepEqual(loaded({}), [3, 10]);
  const both = { PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: "", PLAYBOOKS_MAX_SOURCES_PER_AGENT: "" };
  assert.deepEqual(loaded(both), [3, 10]);
  const large = {
    PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: "1000",
    PLAYBOOKS_MAX_SOURCES_PER_AGENT: "1000",
  };
  assert.deepEqual(loaded(large), [1000, 1000]);
  const least = { PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE: "1", PLAYBOOKS_MAX_SOURCES_PER_AGENT: "1" };
  assert.deepEqual(loaded(least), [1, 1]);
  for (const name of ["PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE", "PLAYBOOKS_MAX_SOURCES_PER_AGENT"]) {
    const invalid = ["config_invalid", "modules/playbooks", [name]];
    for (const value of ["0", "-1", "1.5", "one"]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    // The api host loads the module's build: its index stops the same way.
    assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});
