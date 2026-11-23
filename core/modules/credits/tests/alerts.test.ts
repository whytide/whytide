// The credit alerts' check (gamma-p7-020; README "Alerts"): first the share and the thresholds as a
// table, pure; then the check against this file's schema of the worktree's database, as `app`, at
// fixed instants and periods: two organizations, one under 80 percent and one past 95, each row
// recorded once and the highest answered; two checks at once; a new period, whose thresholds start
// again at its own grant while the last period's rows are never answered; a period with no grant, a
// grant of 0, and carried-over credits, which count in neither figure; and the alerts a check no
// longer answers: mailed, or out of tries. Then the mail of one alert to each recipient once
// (review-gaps-2), on the app-mail fake and tenancy's Owners: a later check after a partial send
// mails only the recipients not recorded, and two mails at once each recipient once. The mails end to
// end are the worker's test, core/apps/worker/tests/credits-alerts.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { AppError, collectLogs, createLogger, newId } from "@whytide/platform";
import { checkAlerts } from "../domain/alerts/check.ts";
import { CREDIT_ALERT_MAX_TRIES } from "../domain/alerts/constants.ts";
import { alertShare } from "../domain/alerts/share.ts";
import { ids } from "../ids.ts";
import { useCreditsClient } from "../testing/index.ts";

// The fake, whatever the environment names, read when the mail's modules load below.
process.env.PROVIDER_APP_MAIL = "fake";
const { failAlert, mailAlert } = await import("../domain/alerts/mail.ts");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const tenancy = await import("@whytide/tenancy/testing");

withTestDb();
useCreditsClient(asRole("app"));
tenancy.useTenancyClient(asRole("app"));
const log = createLogger({ destination: collectLogs().destination });

type Period = { readonly start: Date; readonly end: Date };
const OCTOBER: Period = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-11-01T00:00:00Z"),
};
const NOVEMBER: Period = { start: OCTOBER.end, end: new Date("2026-12-01T00:00:00Z") };
const SEPTEMBER: Period = { start: new Date("2026-09-01T00:00:00Z"), end: OCTOBER.start };
/** The checks' instants, inside October and November. */
const IN_OCTOBER = new Date("2026-10-15T12:00:00Z");
const IN_NOVEMBER = new Date("2026-11-10T08:00:00Z");

test("the share is used ÷ granted in percent, cut, never rounded; it reaches 80, 95 and 100 at their exact values; a grant of 0 has none", () => {
  const cases: [used: string, granted: string, percent: string | null, reached: number[]][] = [
    ["0", "100", "0", []],
    ["79.9", "100", "79.9", []],
    ["79.999999999999999999999999999999", "100", "79.999999999999999999999999999999", []],
    ["80", "100", "80", [80]],
    ["7.99", "10", "79.9", []],
    ["8", "10", "80", [80]],
    ["0.3", "0.375", "80", [80]],
    ["94.99", "100", "94.99", [80]],
    ["95", "100", "95", [80, 95]],
    ["96", "100", "96", [80, 95]],
    ["99.9999", "100", "99.9999", [80, 95]],
    ["100", "100", "100", [80, 95, 100]],
    ["150.5", "100", "150.5", [80, 95, 100]],
    ["1", "3", "33.333333333333333333333333333333", []],
    ["1", "0", null, []],
    ["0", "0", null, []],
  ];
  for (const [used, granted, percent, reached] of cases) {
    const share = alertShare(used, granted);
    assert.deepEqual(
      share === null ? [null, []] : [share.percent, [...share.reached]],
      [percent, reached],
      `${used} of ${granted}`,
    );
  }
});

/** The fixed plan, once per test, for the subscriptions below. */
async function plan(): Promise<string> {
  const code = "self_hosted";
  const { id } = await asRole("billing_writer").plan.upsert({
    where: { code },
    create: { id: newId(ids.plan), code, name: code, monthlyAllowance: 100, isFixed: true },
    update: {},
  });
  return id;
}

/** The organization's subscription in `period`, granted `amount` unless null, as billing_writer. */
async function subscribed(
  organizationId: string,
  period: Period = OCTOBER,
  amount: string | null = "100",
) {
  const billing = asRole("billing_writer");
  const dates = { periodStart: period.start, periodEnd: period.end };
  const { id } = await billing.subscription.create({
    data: { id: newId(ids.subscription), organizationId, planId: await plan(), ...dates },
  });
  if (amount !== null) await grant(organizationId, id, period, amount);
  return id;
}

async function grant(
  organizationId: string,
  subscriptionId: string,
  period: Period,
  amount: string,
) {
  const dates = { periodStart: period.start, periodEnd: period.end };
  const data = {
    id: newId(ids.credit_grant),
    organizationId,
    subscriptionId,
    amount,
    reason: "allowance",
    ...dates,
  };
  await asRole("billing_writer").creditGrant.create({ data });
}

/** The subscription moved to `period` with its grant, as credits_seed_self_hosted moves it. */
async function renewed(
  organizationId: string,
  subscriptionId: string,
  period: Period,
  amount: string,
) {
  const dates = { periodStart: period.start, periodEnd: period.end };
  await asRole("billing_writer").subscription.update({
    where: { id: subscriptionId },
    data: dates,
  });
  await grant(organizationId, subscriptionId, period, amount);
}

/** A usage row of the organization's, `credits` at `status`, created at `at`, as reserve writes one. */
async function spent(
  organizationId: string,
  credits: string,
  at: Date,
  status: "reserved" | "committed" | "released" | "expired" = "committed",
) {
  const id = newId(ids.credit_usage);
  await asRole("app").creditUsage.create({
    data: {
      ...{ id, organizationId, workspaceId: `wsp_${organizationId}`, action: "test.read" },
      ...{ quantity: credits, credits, status, idempotencyKey: id, subjectRef: "lead_test" },
      ...{ leaseExpiresAt: at, createdAt: at },
    },
  });
}

/** The organization's rows, by period and threshold: what the check recorded. */
async function rowsOf(organizationId: string) {
  const rows = await asRole("app").creditAlert.findMany({
    where: { organizationId },
    orderBy: [{ periodStart: "asc" }, { threshold: "asc" }],
  });
  return rows.map((row) => ({
    period: row.periodStart.toISOString().slice(0, 7),
    threshold: row.threshold,
    used: row.used.toString(),
    granted: row.granted.toString(),
  }));
}

/** The thresholds of the alerts a check answers, by organization. */
async function answered(alertIds: readonly string[]) {
  const rows = await asRole("app").creditAlert.findMany({ where: { id: { in: [...alertIds] } } });
  return Object.fromEntries(rows.map((row) => [row.organizationId, row.threshold]));
}

test("79.9 percent records nothing; past 95 percent records 80 and 95 at the crossing's figures and answers 95 alone; 80 percent then records and answers the other organization's 80", async () => {
  await subscribed("org_under");
  await subscribed("org_past");
  await spent("org_under", "79.9", new Date("2026-10-02T09:00:00Z"));
  await spent("org_past", "70", new Date("2026-10-03T09:00:00Z"));
  await spent("org_past", "26", new Date("2026-10-04T09:00:00Z"), "reserved");
  await spent("org_past", "50", new Date("2026-10-05T09:00:00Z"), "released");

  const first = await checkAlerts(IN_OCTOBER);
  assert.deepEqual([first.organizations, first.recorded], [2, 2]);
  assert.deepEqual(await answered(first.alertIds), { org_past: 95 });
  assert.deepEqual(await rowsOf("org_under"), []);
  const crossing = { period: "2026-10", used: "96", granted: "100" };
  assert.deepEqual(await rowsOf("org_past"), [
    { ...crossing, threshold: 80 },
    { ...crossing, threshold: 95 },
  ]);

  await spent("org_under", "0.1", new Date("2026-10-06T09:00:00Z"));
  const second = await checkAlerts(IN_OCTOBER);
  assert.equal(second.recorded, 1, "only the new threshold is recorded");
  assert.deepEqual(await answered(second.alertIds), { org_under: 80, org_past: 95 });
  assert.deepEqual(await rowsOf("org_under"), [
    { period: "2026-10", threshold: 80, used: "80", granted: "100" },
  ]);
});

test("two checks at the same time insert one row per threshold", async () => {
  await subscribed("org_full");
  await spent("org_full", "100", new Date("2026-10-02T09:00:00Z"));

  const checks = await Promise.all([checkAlerts(IN_OCTOBER), checkAlerts(IN_OCTOBER)]);
  assert.equal(checks[0].recorded + checks[1].recorded, 3, "three rows between the two");
  assert.deepEqual(
    (await rowsOf("org_full")).map(({ threshold }) => threshold),
    [80, 95, 100],
  );
  for (const { alertIds } of checks) {
    assert.deepEqual(await answered(alertIds), { org_full: 100 });
  }
});

test("a new period starts the thresholds again at its own grant; the last period's rows are never answered", async () => {
  const subscription = await subscribed("org_renewed", OCTOBER, "100");
  await spent("org_renewed", "85", new Date("2026-10-20T09:00:00Z"));
  await checkAlerts(IN_OCTOBER);
  assert.deepEqual(
    (await rowsOf("org_renewed")).map(({ period, threshold }) => [period, threshold]),
    [["2026-10", 80]],
  );

  await renewed("org_renewed", subscription, NOVEMBER, "200");
  const quiet = await checkAlerts(IN_NOVEMBER);
  assert.deepEqual([quiet.recorded, quiet.alertIds], [0, []], "October's row is past");

  await spent("org_renewed", "150", new Date("2026-11-05T09:00:00Z"));
  const next = await checkAlerts(IN_NOVEMBER);
  assert.equal(next.recorded, 0, "75 percent of the new grant");
  await spent("org_renewed", "10", new Date("2026-11-06T09:00:00Z"));
  const crossed = await checkAlerts(IN_NOVEMBER);
  assert.equal(crossed.recorded, 1);
  assert.deepEqual(await answered(crossed.alertIds), { org_renewed: 80 });
  assert.deepEqual((await rowsOf("org_renewed")).at(-1), {
    period: "2026-11",
    threshold: 80,
    used: "160",
    granted: "200",
  });
});

test("a period with no grant or a grant of 0 records nothing; carried-over credits change neither the share nor the thresholds", async () => {
  await subscribed("org_ungranted", OCTOBER, null);
  await spent("org_ungranted", "5", new Date("2026-10-02T09:00:00Z"));
  await subscribed("org_zero", OCTOBER, "0");
  await spent("org_zero", "0", new Date("2026-10-02T09:00:00Z"));
  // September granted 1,000 and spent 900 of it: 100 carried over, which neither figure counts.
  const carried = await subscribed("org_carried", OCTOBER, "100");
  await grant("org_carried", carried, SEPTEMBER, "1000");
  await spent("org_carried", "900", new Date("2026-09-20T09:00:00Z"));
  await spent("org_carried", "79", new Date("2026-10-02T09:00:00Z"));

  const quiet = await checkAlerts(IN_OCTOBER);
  assert.deepEqual([quiet.organizations, quiet.recorded, quiet.alertIds], [3, 0, []]);

  await spent("org_carried", "1", new Date("2026-10-03T09:00:00Z"));
  const crossed = await checkAlerts(IN_OCTOBER);
  assert.deepEqual(await answered(crossed.alertIds), { org_carried: 80 });
  assert.deepEqual(await rowsOf("org_carried"), [
    { period: "2026-10", threshold: 80, used: "80", granted: "100" },
  ]);
  const balance = await asRole("app").creditBalance.findUniqueOrThrow({
    where: { organizationId: "org_carried" },
  });
  const left = balance.granted.minus(balance.reserved).minus(balance.committed);
  assert.equal(left.toString(), "120", "the balance keeps September's 100 left");
});

test("a check no longer answers an alert once mailed, or once its tries reached CREDIT_ALERT_MAX_TRIES", async () => {
  await subscribed("org_mailed");
  await subscribed("org_tried");
  await spent("org_mailed", "90", new Date("2026-10-02T09:00:00Z"));
  await spent("org_tried", "90", new Date("2026-10-02T09:00:00Z"));
  const first = await checkAlerts(IN_OCTOBER);
  assert.deepEqual(await answered(first.alertIds), { org_mailed: 80, org_tried: 80 });

  const app = asRole("app");
  await app.creditAlert.updateMany({
    where: { organizationId: "org_mailed" },
    data: { notifiedAt: IN_OCTOBER },
  });
  await app.creditAlert.updateMany({
    where: { organizationId: "org_tried" },
    data: { tries: CREDIT_ALERT_MAX_TRIES - 1 },
  });
  assert.deepEqual(await answered((await checkAlerts(IN_OCTOBER)).alertIds), { org_tried: 80 });
  await app.creditAlert.updateMany({
    where: { organizationId: "org_tried" },
    data: { tries: CREDIT_ALERT_MAX_TRIES },
  });
  assert.deepEqual((await checkAlerts(IN_OCTOBER)).alertIds, []);
});

type Send = (input: { to: string; subject: string; text: string }) => Promise<unknown>;
/** The bound fake: its sends kept in order, and its send, which a test may wrap. */
const mails = (await getAdapter(appMailPort, "fake")) as unknown as {
  send: Send;
  sent(): readonly { to: string }[];
};

/**
 * The fake's sends while `fn` runs, each address's calls counted, and the addresses in `failing`
 * refused as mail_unreachable; the calls.
 */
async function watched(failing: ReadonlySet<string>, fn: () => Promise<void>) {
  const send = mails.send;
  const calls = new Map<string, number>();
  mails.send = async (input) => {
    calls.set(input.to, (calls.get(input.to) ?? 0) + 1);
    if (failing.has(input.to)) throw new AppError("mail_unreachable");
    return send(input);
  };
  try {
    await fn();
  } finally {
    mails.send = send;
  }
  return calls;
}

/** An organization at 80 percent in October with an Owner, an Admin and another Owner, and its alert. */
async function alerted() {
  const { organization, workspace } = await tenancy.createOrganizationWithWorkspace();
  const emails: string[] = [];
  for (const role of ["Owner", "Admin", "Owner"] as const) {
    const user = await tenancy.createUser();
    await tenancy.createMembership({ userId: user.id, workspaceId: workspace.id, role });
    emails.push(user.email);
  }
  await subscribed(organization.id);
  await spent(organization.id, "80", new Date("2026-10-02T09:00:00Z"));
  const [alertId] = (await checkAlerts(IN_OCTOBER)).alertIds;
  assert.ok(alertId);
  return { organizationId: organization.id, alertId, emails };
}

const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to).length;
const recorded = (alertId: string) => asRole("app").creditAlertMail.count({ where: { alertId } });

test("a later check after a partial send mails only the recipients not recorded; the alert is marked once every recipient is recorded, and failAlert raises the tries of one not marked", async () => {
  const { organizationId, alertId, emails } = await alerted();
  const [first, failing, third] = emails as [string, string, string];
  const calls = await watched(new Set([failing]), async () => {
    await assert.rejects(mailAlert(alertId, { log }), { code: "mail_unreachable" });
  });
  assert.deepEqual([...calls.values()], [1, 1, 1], "each one tried once, the failing one too");
  assert.deepEqual(emails.map(mailsTo), [1, 0, 1]);
  assert.equal(await recorded(alertId), 2);
  assert.equal(await failAlert(alertId, { log }), 1);
  const [row] = await asRole("app").creditAlert.findMany({ where: { organizationId } });
  assert.deepEqual([row?.tries, row?.notifiedAt], [1, null]);

  assert.deepEqual((await checkAlerts(IN_OCTOBER)).alertIds, [alertId], "a later check");
  const later = await watched(new Set(), async () => {
    assert.deepEqual(await mailAlert(alertId, { log }), { sent: true, recipients: 3 });
  });
  assert.deepEqual([...later.keys()], [failing], "only the one not recorded");
  assert.deepEqual([first, failing, third].map(mailsTo), [1, 1, 1]);
  assert.equal(await recorded(alertId), 3);
  const [marked] = await asRole("app").creditAlert.findMany({ where: { organizationId } });
  assert.ok(marked?.notifiedAt instanceof Date);
  assert.equal(await failAlert(alertId, { log }), 0, "a mailed alert's tries stay");
});

test("two mails of one alert at once mail each recipient once, and one of them answers already_sent", async () => {
  const { alertId, emails } = await alerted();
  const results = await Promise.all([mailAlert(alertId, { log }), mailAlert(alertId, { log })]);
  assert.deepEqual(emails.map(mailsTo), [1, 1, 1]);
  assert.equal(await recorded(alertId), 3);
  assert.deepEqual(
    results.filter((result) => result.sent),
    [{ sent: true, recipients: 3 }],
  );
  assert.deepEqual(
    results.filter((result) => !result.sent),
    [{ sent: false, reason: "already_sent" }],
  );
});
