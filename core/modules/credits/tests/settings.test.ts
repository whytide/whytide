// credits' settings from the environment (env-settings-b; README "Settings"), on the worktree's
// database: set to thresholds 50, 80 and 100 (written out of order) and a 14-day notice before the
// module loads, a share of 96 percent records 50 and 80 and no 95, and a rise applies 14 days after
// its start. The migration widens credit_alerts' CHECK on a table holding today's 80, 95 and 100,
// then takes a 50 and refuses 0 and 101. Off their forms, the settings stop the module's load with
// config_invalid naming them, read in a process of their own; the api's start loads the module so.
// tests/alerts.test.ts and tests/prices.test.ts run the defaults.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.CREDITS_ALERT_THRESHOLDS = " 100, 50 ,80";
process.env.CREDITS_PRICE_CHANGE_NOTICE_DAYS = "14";
const { asRole, sqlstate, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, newId } = await import("@whytide/platform");
const { checkAlerts } = await import("../domain/alerts/check.ts");
const { alertShare } = await import("../domain/alerts/share.ts");
const { DAY_MS } = await import("../domain/constants.ts");
const { syncPrices } = await import("../domain/prices.ts");
const { ids } = await import("../ids.ts");
const { settings } = await import("../settings.ts");
const { useCreditsClient } = await import("../testing/index.ts");

withTestDb();
useCreditsClient(asRole("app"));
const log = createLogger({ destination: collectLogs().destination });
const OCTOBER = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") };
const IN_OCTOBER = new Date("2026-10-15T12:00:00Z");

/** The organization's subscription in October, granted 100 credits, and `used` of them committed. */
async function used(organizationId: string, credits: string) {
  const billing = asRole("billing_writer");
  const code = "self_hosted";
  const plan = await billing.plan.upsert({
    where: { code },
    create: { id: newId(ids.plan), code, name: code, monthlyAllowance: 100, isFixed: true },
    update: {},
  });
  const dates = { periodStart: OCTOBER.start, periodEnd: OCTOBER.end };
  const subscription = await billing.subscription.create({
    data: { id: newId(ids.subscription), organizationId, planId: plan.id, ...dates },
  });
  const grant = { organizationId, subscriptionId: subscription.id, amount: "100", ...dates };
  await billing.creditGrant.create({
    data: { id: newId(ids.credit_grant), reason: "allowance", ...grant },
  });
  const id = newId(ids.credit_usage);
  await asRole("app").creditUsage.create({
    data: {
      ...{ id, organizationId, workspaceId: `wsp_${organizationId}`, action: "test.read" },
      ...{ quantity: credits, credits, status: "committed", idempotencyKey: id },
      ...{ subjectRef: "lead_test", leaseExpiresAt: IN_OCTOBER, createdAt: IN_OCTOBER },
    },
  });
}

test("thresholds 50,80,100: 96 percent records 50 and 80 and no 95, and the check answers 80", async () => {
  assert.deepEqual(settings.CREDITS_ALERT_THRESHOLDS, [50, 80, 100], "lowest first");
  const reached = (percent: string) => alertShare(percent, "100")?.reached;
  assert.deepEqual(["49.9", "50", "96", "100"].map(reached), [[], [50], [50, 80], [50, 80, 100]]);
  await used("org_half", "96");
  const check = await checkAlerts(IN_OCTOBER);
  assert.equal(check.recorded, 2);
  const rows = await asRole("app").creditAlert.findMany({ orderBy: { threshold: "asc" } });
  assert.deepEqual(
    rows.map(({ threshold }) => threshold),
    [50, 80],
  );
  assert.deepEqual(check.alertIds, [rows[1]?.id]);
});

test("a 14-day notice: a rise announced at a start applies 14 days after it, the version before in effect until then", async () => {
  assert.equal(settings.CREDITS_PRICE_CHANGE_NOTICE_DAYS, 14);
  const writer = asRole("billing_writer");
  const at = new Date("2026-11-02T09:00:00Z");
  const entry = (credits: string) => [{ action: "test.a", credits, unit: "lead" }];
  assert.equal(await syncPrices(writer, entry("1"), log, at), 1);
  const rise = new Date(at.getTime() + DAY_MS);
  assert.equal(await syncPrices(writer, entry("2"), log, rise), 1, "the rise waits");
  const versions = await writer.priceListEntry.findMany({ orderBy: { version: "asc" } });
  assert.deepEqual(
    versions.map(({ version, effectiveFrom, announcedAt }) => [
      version,
      effectiveFrom,
      announcedAt,
    ]),
    [
      [1, at, null],
      [2, new Date(rise.getTime() + 14 * DAY_MS), rise],
    ],
  );
});

/** The statements of the migration that widens the CHECK, as written. */
function migration(): string[] {
  const folder = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  const name = readdirSync(folder).find((one) => one.endsWith("_credits_alert_thresholds"));
  const sql = readFileSync(new URL(`${name}/migration.sql`, folder), "utf8");
  const code = sql.replace(/^--.*$/gm, "");
  return code.split(";").filter((statement) => statement.trim() !== "");
}

test("the migration applies on a table holding today's 80, 95 and 100, which stay; then 50 is taken and 0 and 101 refused", async () => {
  const owner = asRole("owner");
  // Today's database: the CHECK as 20261113025150_credits_alerts wrote it.
  await owner.$executeRawUnsafe(
    `ALTER TABLE "credit_alerts" DROP CONSTRAINT "credit_alerts_threshold"`,
  );
  await owner.$executeRawUnsafe(`ALTER TABLE "credit_alerts" ADD CONSTRAINT "credit_alerts_threshold"
    CHECK ("threshold" IN (80, 95, 100))`);
  const insert = (threshold: number) =>
    asRole("app").$executeRaw`INSERT INTO credit_alerts
      (id, organization_id, period_start, threshold, used, granted)
      VALUES (${newId(ids.credit_alert)}, 'org_today', ${OCTOBER.start}, ${threshold}, 100, 100)`;
  for (const threshold of [80, 95, 100]) assert.equal(await sqlstate(insert(threshold)), undefined);
  assert.equal(await sqlstate(insert(50)), "23514", "refused before the migration");
  for (const statement of migration()) await owner.$executeRawUnsafe(statement);
  assert.equal(await sqlstate(insert(50)), undefined);
  for (const threshold of [0, 101]) assert.equal(await sqlstate(insert(threshold)), "23514");
  const rows = await owner.creditAlert.findMany({ orderBy: { threshold: "asc" } });
  assert.deepEqual(
    rows.map(({ threshold }) => threshold),
    [50, 80, 95, 100],
  );
});

/** What a process with `env` set reads as the module loads: the two settings, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify([settings.CREDITS_ALERT_THRESHOLDS, settings.CREDITS_PRICE_CHANGE_NOTICE_DAYS]));",
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

test("the thresholds are whole percents from 1 to 100, each once, 80,95,100 unset or empty; the notice a whole number of days of 1 or more with no maximum, 30 unset; otherwise the module's load stops on config_invalid naming the variable", () => {
  const THRESHOLDS = "CREDITS_ALERT_THRESHOLDS";
  const NOTICE = "CREDITS_PRICE_CHANGE_NOTICE_DAYS";
  const defaults = [[80, 95, 100], 30];
  assert.deepEqual([loaded({}), loaded({ [THRESHOLDS]: "", [NOTICE]: "" })], [defaults, defaults]);
  const set = { [THRESHOLDS]: "100,1, 37", [NOTICE]: "1000" };
  assert.deepEqual(loaded(set), [[1, 37, 100], 1000]);
  assert.deepEqual(loaded({ [THRESHOLDS]: "100" }), [[100], 30]);
  const invalid = (name: string) => ["config_invalid", "modules/credits", [name]];
  for (const value of ["80,80", "0", "101", "50,0,101", "80,,95", ",", "eighty", "1.5", "-5"]) {
    assert.deepEqual(
      loaded({ [THRESHOLDS]: value }),
      invalid(THRESHOLDS),
      `${THRESHOLDS}=${value}`,
    );
  }
  for (const value of ["0", "-1", "1.5", "one"]) {
    assert.deepEqual(loaded({ [NOTICE]: value }), invalid(NOTICE), `${NOTICE}=${value}`);
  }
  // The api host loads the module's build: its index stops the same way.
  const atLoad = loaded({ [THRESHOLDS]: "80,80" }, "../dist/index.js");
  assert.deepEqual(atLoad, invalid(THRESHOLDS), "at load");
});
