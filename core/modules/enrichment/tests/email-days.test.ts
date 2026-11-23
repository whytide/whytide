// The email lookup's days from the environment (env-settings-b; README "Settings"), on the worktree's
// database: set to 90 and 60 before the module loads, an address verified 90 days ago is the last
// one a lookup trusts, an `email` cache entry lasts 90 days and a `negative` one 60, one kind
// replacing the other. Not an integer of 1 or more, each setting stops the module's load with
// config_invalid naming it, while a large value loads, read in a process of its own; the worker's
// and the api's starts load the module so. The worker's tests/enrichment-lookup.test.ts runs the
// defaults end to end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.ENRICHMENT_EMAIL_VALID_DAYS = "90";
process.env.ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS = "60";
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { servicePrincipal } = await import("@whytide/platform");
const { validSince, writeCache } = await import("../domain/lookup/points.ts");
const { settings } = await import("../settings.ts");

withTestDb();
const app = asRole("app");
const WS = "wsp_enrichment_email_days";
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal: servicePrincipal("enrichment_test") }, fn, {
    client: app,
  });
const AT = new Date("2026-11-15T09:00:00Z");
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(AT.getTime() + count * DAY_MS);

test("set to 90 and 60 days: a lookup trusts an address verified 90 days ago at most; an email entry lasts 90 days, a negative one 60", async () => {
  const configured = [
    settings.ENRICHMENT_EMAIL_VALID_DAYS,
    settings.ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS,
  ];
  assert.deepEqual(configured, [90, 60]);
  assert.deepEqual(validSince(AT), days(-90));
  const entry = { personId: "per_email_days", keyHash: "a".repeat(64), provider: "fake", at: AT };
  const expiries = async () =>
    (await app.enrichmentCacheEntry.findMany({ where: { workspaceId: WS } })).map(
      ({ kind, expiresAt }) => [kind, expiresAt],
    );
  await run(() => writeCache({ ...entry, kind: "negative", reason: "not_found" }));
  assert.deepEqual(await expiries(), [["negative", days(60)]]);
  await run(() => writeCache({ ...entry, kind: "email", address: "noor@blue.example" }));
  assert.deepEqual(
    await expiries(),
    [["email", days(90)]],
    "the email entry replaces the negative",
  );
});

/** What a process with `env` set reads as the module loads: the two days, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify([settings.ENRICHMENT_EMAIL_VALID_DAYS, settings.ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS]));",
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

test("each of the two is an integer of 1 or more with no maximum, 120 and 30 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  const VALID = "ENRICHMENT_EMAIL_VALID_DAYS";
  const RETRY = "ENRICHMENT_EMAIL_NOT_FOUND_RETRY_DAYS";
  assert.deepEqual(
    [loaded({}), loaded({ [VALID]: "", [RETRY]: "" })],
    [
      [120, 30],
      [120, 30],
    ],
  );
  assert.deepEqual(loaded({ [VALID]: "1000", [RETRY]: "1" }), [1000, 1]);
  for (const name of [VALID, RETRY]) {
    const invalid = ["config_invalid", "modules/enrichment", [name]];
    for (const value of ["0", "-1", "1.5", "one"]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    // The hosts load the module's build: its index stops the same way.
    assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});
