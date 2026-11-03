// linkedin's daily health check (beta-p6-020; core/modules/linkedin/README.md "Health", "Worker"),
// inside the hourly linkedin_status_refresh, on the slice's Temporal and a schema of its database,
// the LinkedIn and app-mail fakes bound: the host started with linkedin from its build, as the worker
// loads it, on linkedin's clock. The day's pending-invite check ends with the acceptance rule: 19
// accepted of the last 100 invites at least 7 days old pause the account's invites (at_risk) once the
// count is written, and its owner gets one mail through the outbox and linkedin_notify; a later day's
// check at 20 of 100 lifts the pause, with no mail; an acceptance the webhook missed, found by the
// same check, counts. A status check that fails leaves its row with the error's code, is called once
// a run and sets retry_at, so the check after it is refused its reads; the third in the hour pauses
// the account until its next working day; the next hourly run checks again. The recorded histories
// of linkedin_status_refresh replay. It lives here: a module never imports a host. While retry_at
// lies ahead, the hourly run makes no status call (beta-p6-040).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Sender } from "./fixtures/linkedin-send.ts";

process.env.PROVIDER_APP_MAIL = "fake";

const send = await import("./fixtures/linkedin-send.ts");
const { db, fake, later, linkedin, reserveSend, sender, THURSDAY } = send;
const { Client, Connection } = await import("@temporalio/client");
const { collectLogs, createLogger } = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { workerConfig } = await import("../src/config.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { generatedWorkflows } = await import("../src/temporal.ts");
const { replayHistories } = await import("../testing/index.ts");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const tenancy: TenancyTesting = await import(
  new URL("../../../modules/tenancy/dist/testing/index.js", import.meta.url).href
);
type Hash = typeof import("../../../modules/linkedin/dist/domain/hash.js");
const hash: Hash = await import(
  new URL("../../../modules/linkedin/dist/domain/hash.js", import.meta.url).href
);

send.useSendTests();
linkedin.useRandom(() => 0.5);
const { start } = await import("../src/start.ts");
const log = createLogger({ destination: collectLogs().destination });
type AppMailFake = { sent(): readonly { to: string; subject: string; text: string }[] };
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const histories = ["linkedin_status_refresh.json", "linkedin_status_refresh_invites.json"].map(
  (file) =>
    fileURLToPath(
      new URL(`../../../modules/linkedin/workflows/__histories__/${file}`, import.meta.url),
    ),
);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CHECK_CALLS = new Set(["listPendingInvites", "getRelation"]);
const PAUSED = "linkedin.account_paused";
const SUBJECT = "Whytide paused the connection requests of your LinkedIn account";

/** `fn` with the host started, linkedin alone, on a queue of its own, and its hourly run; closed after. */
async function withHost(fn: (hourly: () => Promise<unknown>) => Promise<void>) {
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  const modules = moduleLoaders.filter(({ name }) => name === "linkedin");
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    client: db(),
    log,
    schedules: "off",
  });
  const hourly = () =>
    temporal.workflow.execute("linkedin_status_refresh", {
      args: [{}],
      taskQueue,
      workflowId: `linkedin_status_refresh-${randomUUID()}`,
    });
  try {
    await fn(hourly);
  } finally {
    await host.close();
    await connection.close();
  }
}

/**
 * The fixture's account, its member id the fake's own, so that the refresh replaces nothing, and its
 * owner a user of tenancy's, the mail's recipient.
 */
async function account(): Promise<Sender & { email: string }> {
  const made = await sender();
  const { memberRef } = await fake.getAccountStatus(made.ref);
  const memberIdHash = hash.memberHash(memberRef ?? "");
  const { id: ownerUserId, email } = await tenancy.createUser();
  const data = { memberIdHash, ownerUserId };
  await db().senderAccount.update({ where: { id: made.accountId }, data });
  return { ...made, email };
}

/** `count` invites `days` days before THURSDAY, a minute apart going back, the first `accepted` accepted. */
function invites(a: Sender, days: number, count: number, accepted: number) {
  const rows = Array.from({ length: count }, (_, i) => {
    const invitedAt = new Date(THURSDAY.getTime() - days * DAY_MS - i * MINUTE_MS);
    return { invitedAt, acceptedAt: i < accepted ? new Date(invitedAt.getTime() + HOUR_MS) : null };
  });
  return linkedin.createInvites(a.workspaceId, a.accountId, rows);
}

const checkCalls = () =>
  fake.recordedCalls.filter(({ method }) => CHECK_CALLS.has(method)).map(({ method }) => method);
const statusCalls = () =>
  fake.recordedCalls.filter(({ method }) => method === "getAccountStatus").length;
const row = (id: string) => db().senderAccount.findUniqueOrThrow({ where: { id } });
const days = (senderAccountId: string) =>
  db().senderQuotaUsage.findMany({ where: { senderAccountId }, orderBy: { quotaDay: "asc" } });
const events = (senderId: string) =>
  db().senderHealthEvent.findMany({ where: { senderId }, orderBy: [{ createdAt: "asc" }] });
const paused = (workspaceId: string) =>
  db().outboxEntry.count({ where: { workspaceId, eventName: PAUSED } });
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
/** The account's log rows of a kind, by outcome, oldest first. */
async function logged(senderAccountId: string, kind: "status_check" | "pending_invites") {
  const rows = await db().senderActionLog.findMany({
    where: { senderAccountId, kind },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  return rows.map(({ outcome }) => outcome);
}
/** linkedin's clock, as the fixture moves it from THURSDAY at each test's start. */
let clock = THURSDAY;
const moveTo = (instant: Date): void => {
  later(instant.getTime() - clock.getTime());
  clock = instant;
};
/** The day's row made by an hourly run at `at`, then the clock a minute past its check_after. */
async function checkDue(hourly: () => Promise<unknown>, a: Sender, at: Date): Promise<Date> {
  moveTo(at);
  await hourly();
  const checkAfter = (await days(a.accountId)).at(-1)?.checkAfter ?? null;
  assert.ok(checkAfter !== null && checkAfter > at, "not due before check_after");
  const due = new Date(checkAfter.getTime() + MINUTE_MS);
  moveTo(due);
  return due;
}
/** The first truthy answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T> | T): Promise<NonNullable<T>> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 30 seconds");
    await sleep(50);
  }
}

test("the hourly run's daily check ends with the acceptance rule: 19 of the last 100 invites at least 7 days old pause the account's invites once the count is written, with one mail to the owner, while a message reserves; a later day's check at 20 of 100 lifts the pause, with no mail", () =>
  withHost(async (hourly) => {
    clock = THURSDAY;
    const a = await account();
    const rows = await invites(a, 8, 100, 19);
    const checkedAt = await checkDue(hourly, a, THURSDAY);
    assert.deepEqual(await hourly(), { accounts: 1, failed: 0 });
    assert.deepEqual(
      checkCalls(),
      ["listPendingInvites"],
      "the list's page: the rule calls nothing",
    );
    const after = await row(a.accountId);
    assert.deepEqual(
      [after.healthState, after.pendingInvites, after.pendingInvitesCheckedAt],
      ["at_risk", 0, checkedAt],
    );
    const [event, ...more] = await events(a.accountId);
    assert.ok(event !== undefined && more.length === 0);
    assert.deepEqual(
      [event.fromState, event.toState, event.trigger, event.metrics, event.createdAt],
      [
        "healthy",
        "at_risk",
        "acceptance_rate",
        { sample: 100, accepted: 19, rate: 0.19 },
        checkedAt,
      ],
    );
    const [mail] = await until(() => (mailsTo(a.email).length > 0 ? mailsTo(a.email) : null));
    assert.equal(mail?.subject, SUBJECT);
    assert.match(mail?.text ?? "", /^Too few of your LinkedIn account's connection requests/);
    const reserve = (key: string, actionType: "invite" | "message") =>
      a.run(() => reserveSend({ accountId: a.accountId, actionType, idempotencyKey: key }));
    assert.deepEqual(await reserve("invite-paused", "invite"), {
      refused: "invites_paused",
      retryAt: null,
    });
    assert.ok("reservationId" in (await reserve("message-goes", "message")));

    const late = rows[60];
    assert.ok(late !== undefined);
    await db().senderOutreach.update({ where: { id: late.id }, data: { acceptedAt: clock } });
    const friday = await checkDue(hourly, a, new Date("2026-10-23T08:00:00Z"));
    await hourly();
    assert.equal((await row(a.accountId)).healthState, "healthy");
    const lifted = (await events(a.accountId))[1];
    assert.deepEqual(
      [lifted?.toState, lifted?.trigger, lifted?.metrics, lifted?.createdAt],
      ["healthy", "acceptance_rate", { sample: 100, accepted: 20, rate: 0.2 }, friday],
    );
    assert.equal(await paused(a.workspaceId), 1, "no linkedin.account_paused for the lift");
    assert.ok("reservationId" in (await reserve("invite-again", "invite")));
    assert.equal(mailsTo(a.email).length, 1, "one mail");
  }));

test("an acceptance the webhook missed, found by the same day's check, counts toward the rate: 19 accepted and the one found make 20 of 100, and the account stays healthy", () =>
  withHost(async (hourly) => {
    clock = THURSDAY;
    const a = await account();
    const step = await a.step("invite");
    const sent = await a.call("linkedin_send_invite", step.input());
    assert.deepEqual(sent, { sent: true, stepExecutionId: step.stepExecutionId });
    fake.acceptInvite(a.ref, step.memberRef); // no webhook
    await invites(a, 1, 99, 19);
    // Eight days on, the invite sent on THURSDAY is 7 days old and more.
    const checkedAt = await checkDue(hourly, a, new Date(THURSDAY.getTime() + 8 * DAY_MS));
    await hourly();
    assert.deepEqual(checkCalls(), ["listPendingInvites", "getRelation"]);
    const found = await db().senderOutreach.findFirstOrThrow({
      where: { personId: step.personId },
    });
    assert.deepEqual(found.acceptedAt, checkedAt);
    assert.equal((await row(a.accountId)).healthState, "healthy");
    assert.deepEqual(await events(a.accountId), []);
  }));

test("a status check that fails leaves its row with the error's code and is called once a run, never retried: an hour's retry_at that refuses the day's check its reads, and no status call while it lies ahead; the third in the hour, rate limits a minute long, pauses the account until its next working day, when the hourly run checks again", () =>
  withHost(async (hourly) => {
    clock = THURSDAY;
    const a = await account();
    const before = statusCalls(); // account()'s own, for the member id
    const calls = () => statusCalls() - before;
    const due = await checkDue(hourly, a, THURSDAY);
    assert.equal(calls(), 1);

    fake.failNext("linkedin_provider_error");
    assert.deepEqual(await hourly(), { accounts: 1, failed: 0 }, "answered, not thrown");
    assert.equal(calls(), 2, "one call: no retry");
    assert.deepEqual(await logged(a.accountId, "status_check"), [
      "connected",
      "linkedin_provider_error",
    ]);
    const failed = await row(a.accountId);
    assert.deepEqual(
      [failed.status, failed.retryAt],
      ["connected", new Date(due.getTime() + HOUR_MS)],
    );
    assert.deepEqual(checkCalls(), [], "the check after it is refused its reads");
    assert.deepEqual(await logged(a.accountId, "pending_invites"), ["rate_limited"]);

    moveTo(new Date(due.getTime() + 30 * MINUTE_MS));
    await hourly();
    assert.equal(calls(), 2, "no call while retry_at lies ahead");
    assert.equal((await logged(a.accountId, "status_check")).length, 2, "and no row");

    // Each rate limit holds the account a minute (the fake's retryAfterSec): each next run calls.
    const start = due.getTime() + HOUR_MS + MINUTE_MS;
    for (const minutes of [0, 20, 40]) {
      moveTo(new Date(start + minutes * MINUTE_MS));
      fake.failNext("linkedin_rate_limited");
      await hourly();
    }
    assert.equal(calls(), 5);
    const friday = new Date("2026-10-23T00:00:00Z");
    assert.deepEqual((await row(a.accountId)).retryAt, friday, "Friday 00:00 in UTC");
    const [event] = await events(a.accountId);
    assert.deepEqual([event?.trigger, event?.toState], ["rate_limit_errors", "healthy"]);

    moveTo(new Date(friday.getTime() + MINUTE_MS));
    await hourly();
    assert.equal(calls(), 6, "the hourly run checks again");
    assert.equal((await logged(a.accountId, "status_check")).at(-1), "connected");
  }));

test("the recorded histories of linkedin_status_refresh, before and after the pending-invite check, replay", () =>
  replayHistories(generatedWorkflows, histories));
