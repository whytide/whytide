// How long an invite stays open, from the environment (env-settings-b; README "Settings"), on the
// worktree's database: set to 14 days before the module loads, createInvite's invite is open until 14
// days later and expired from then, a renewal too. Not an integer of 1 or more, the setting stops the
// module's load with config_invalid naming it, while a large value loads, read in a process of its
// own; the api's start loads the module so. tests/invites.test.ts runs the default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.IDENTITY_INVITE_TTL_DAYS = "14";
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { createTwoWorkspaces, useTenancyClient } = await import("@whytide/tenancy/testing");
const { createInvite } = await import("../domain/invites.ts");
const { INVITE_TTL_MS, inviteState } = await import("../domain/rules.ts");
const { settings } = await import("../settings.ts");
const { useIdentityClient, useIdentityClock } = await import("../testing/index.ts");

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
afterEach(() => useIdentityClock(undefined));

const T0 = new Date("2026-11-15T09:00:00.000Z");
const DAY_MS = 86_400_000;
const later = (ms: number) => new Date(T0.getTime() + ms);

test("set to 14 days: an invite made is open until 14 days later, expired from then, and its renewal open 14 days again", async () => {
  assert.deepEqual([settings.IDENTITY_INVITE_TTL_DAYS, INVITE_TTL_MS], [14, 14 * DAY_MS]);
  const [a] = await createTwoWorkspaces();
  const input = { workspaceId: a.workspace.id, email: "kai@example.test", role: "Member" as const };
  useIdentityClock(() => T0);
  const made = await createInvite({ ...input, invitedBy: a.user.id });
  assert.deepEqual(made.expiresAt, later(14 * DAY_MS));
  assert.equal(inviteState(made, later(14 * DAY_MS - 1)), "open");
  assert.equal(inviteState(made, later(14 * DAY_MS)), "expired");
  useIdentityClock(() => later(20 * DAY_MS));
  const renewed = await createInvite({ ...input, invitedBy: a.user.id });
  assert.deepEqual(renewed.expiresAt, later(34 * DAY_MS));
});

/** What a process with `env` set reads as the module loads: the days, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify(settings.IDENTITY_INVITE_TTL_DAYS));",
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("IDENTITY_INVITE_TTL_DAYS is an integer of 1 or more with no maximum, 7 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  const name = "IDENTITY_INVITE_TTL_DAYS";
  assert.deepEqual([loaded({}), loaded({ [name]: "" })], [7, 7]);
  assert.deepEqual([loaded({ [name]: "1" }), loaded({ [name]: "1000" })], [1, 1000]);
  const invalid = ["config_invalid", "modules/identity", [name]];
  for (const value of ["0", "-1", "1.5", "one"]) {
    assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
  }
  // The api host loads the module's build: its index stops the same way.
  assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
});
