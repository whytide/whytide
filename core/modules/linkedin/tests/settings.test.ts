// The note budget from the environment (env-settings-a; README.md "Settings"), on the worktree's
// database: set to 5 before the module loads, an account sends five invitations with a note in 30
// days, where LinkedIn's 3 would refuse the fourth, and the sixth waits until the oldest is 30 days
// old. Not an integer of 1 or more, the setting stops the module's load with config_invalid naming
// it, while a large value loads, read in a process of its own, as playbooks' tests/limits.test.ts
// reads its limits. tests/send-reservations.test.ts runs the default.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.LINKEDIN_INVITE_NOTES_PER_MONTH = "5";
const { logAction } = await import("../domain/action-log/log.ts");
const { DAY_MS } = await import("../domain/quota/constants.ts");
const { noteSettings } = await import("../settings.ts");
const { useClock, useLinkedinClient, useRandom } = await import("../testing/index.ts");
const { granted, sender, THURSDAY } = await import("./fixtures/send.ts");

withTestDb();
useLinkedinClient(asRole("app"));
let at = THURSDAY;
useClock(() => at);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests
const STEP = "sx_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOTE = { withNote: true };

test("set to 5: an account sends five invitations with a note in 30 days, LinkedIn's three passed, and the sixth waits until the oldest is 30 days old", async () => {
  assert.equal(noteSettings.LINKEDIN_INVITE_NOTES_PER_MONTH, 5);
  const account = await sender();
  for (const daysAgo of [25, 20, 10, 1]) {
    at = new Date(THURSDAY.getTime() - daysAgo * DAY_MS);
    await account.run(() =>
      logAction({
        accountId: account.id,
        kind: "invite",
        objectRef: STEP,
        count: 1,
        outcome: "ok",
        withNote: true,
      }),
    );
  }
  at = THURSDAY;
  granted(await account.send("key-n5", "invite", NOTE));
  const opens = new Date(THURSDAY.getTime() + 5 * DAY_MS); // the oldest note, 30 days on
  assert.deepEqual(await account.send("key-n6", "invite", NOTE), {
    refused: "invite_note_budget",
    retryAt: opens,
  });
});

const NAME = "LINKEDIN_INVITE_NOTES_PER_MONTH";

/** What a process with `env` set reads as `entry` loads: the budget, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const href = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    "try {",
    `  await import(${href(entry)});`,
    `  const { noteSettings } = await import(${href("../settings.ts")});`,
    `  console.log(JSON.stringify(noteSettings.${NAME}));`,
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", PROVIDER_LINKEDIN: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("the budget is an integer of 1 or more with no maximum, 3 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.equal(loaded({}), 3);
  assert.equal(loaded({ [NAME]: "" }), 3);
  assert.equal(loaded({ [NAME]: "1" }), 1);
  assert.equal(loaded({ [NAME]: "1000" }), 1000);
  const invalid = ["config_invalid", "modules/linkedin", [NAME]];
  for (const value of ["0", "-1", "1.5", "five"]) {
    assert.deepEqual(loaded({ [NAME]: value }), invalid, `${NAME}=${value}`);
  }
  // The hosts load the module's build: its index stops the same way.
  assert.deepEqual(loaded({ [NAME]: "0" }, "../dist/index.js"), invalid, `${NAME} at load`);
});
