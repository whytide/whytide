// The recent touch from the environment (env-settings-a; README.md "Settings"), on the worktree's
// database, as tests/outreach.test.ts runs Approve: set to 120 days before the module loads, a person
// touched 100 days ago, whom the default 90 would let through, is refused a new enrollment, and
// Approve's refusal answers the 120 days the lead page names; one touched 121 days ago is approved,
// and the next step of an enrollment is never refused. Not an integer of 1 or more, the setting stops
// the module's load with config_invalid naming it, read in a process of its own, as playbooks'
// tests/limits.test.ts reads its limits; unset or empty, 90. The send-safety case of the default is
// the worker's tests/safety/withdrawal.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { type Principal, servicePrincipal } from "@whytide/platform";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.CONTACTS_RECENT_TOUCH_DAYS = "120";
const { createLeadForPerson } = await import("../domain/leads.ts");
const { approveLead } = await import("../domain/outreach/status.ts");
const { upsertPersonFromSource } = await import("../domain/persons.ts");
const { recordTouch, suppressionOf } = await import("../domain/suppression/checks.ts");
const { touchSettings } = await import("../settings.ts");
const { useHashSalt } = await import("../testing/index.ts");

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WORKSPACE = "wsp_contacts_settings";
const tester: Principal = {
  userId: "usr_settings_tester",
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const DAY_MS = 86_400_000;
const run = <T>(fn: () => Promise<T>, principal = servicePrincipal("contacts_test")) =>
  withTenant({ workspaceId: WORKSPACE, principal }, fn, { client: asRole("app") });

/** A person of the workspace with a lead, last touched `daysAgo` days before now; its id. */
async function touchedAgo(slug: string, daysAgo: number): Promise<string> {
  return run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    await recordTouch(person.id, new Date(Date.now() - daysAgo * DAY_MS));
    return person.id;
  });
}

test("set to 120 days: a person touched 100 days ago is refused a new enrollment and Approve answers recently_contacted with the 120 days; one touched 121 days ago is approved; the next step is never refused", async () => {
  assert.equal(touchSettings.CONTACTS_RECENT_TOUCH_DAYS, 120);
  const recent = await touchedAgo("noor-settings-recent", 100);
  const older = await touchedAgo("noor-settings-older", 121);
  const check = (personId: string, newEnrollment: boolean) =>
    run(() => suppressionOf(personId, { newEnrollment }));
  const refused = { suppressed: true, reason: "recently_contacted" };
  assert.deepEqual(await check(recent, true), refused);
  assert.deepEqual(await check(recent, false), { suppressed: false });
  assert.deepEqual(await check(older, true), { suppressed: false });
  await assert.rejects(
    run(() => approveLead(recent), tester),
    { code: "person_suppressed", details: { reason: "recently_contacted", days: 120 } },
  );
  assert.equal(await run(() => approveLead(older), tester), "approved");
});

const NAME = "CONTACTS_RECENT_TOUCH_DAYS";

/** What a process with `env` set reads as `entry` loads: the days, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const href = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    "try {",
    `  await import(${href(entry)});`,
    `  const { touchSettings } = await import(${href("../settings.ts")});`,
    `  console.log(JSON.stringify(touchSettings.${NAME}));`,
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

test("the days are an integer of 1 or more with no maximum, 90 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.equal(loaded({}), 90);
  assert.equal(loaded({ [NAME]: "" }), 90);
  assert.equal(loaded({ [NAME]: "1" }), 1);
  assert.equal(loaded({ [NAME]: "1000" }), 1000);
  const invalid = ["config_invalid", "modules/contacts", [NAME]];
  for (const value of ["0", "-90", "90.5", "ninety"]) {
    assert.deepEqual(loaded({ [NAME]: value }), invalid, `${NAME}=${value}`);
  }
  // The hosts load the module's build: its index stops the same way.
  assert.deepEqual(loaded({ [NAME]: "0" }, "../dist/index.js"), invalid, `${NAME} at load`);
});
