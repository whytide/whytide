// The owner's resume after a cool-down, its safety cases (beta-p6-040; RB-11.3.1 R5; README.md
// "Health"), run by `test:safety`: each refusal in its order; healthy at half its targets after the
// cool-down, today's limits never higher, the events acknowledged, no mail, the breaker still on; a
// checkpoint only after a pairing since its latest warning; two presses at once resume once. The
// routes': the api's tests.
import assert from "node:assert/strict";
import test from "node:test";
import { createDbClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, loadMasterKeys, newMasterKey, quotaDay } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { findAccount } from "../../domain/accounts.ts";
import { type ResumeAccount, resumeAccount, resumeRefusal } from "../../domain/health/resume.ts";
import { refHash } from "../../domain/provider.ts";
import { dayOf } from "../../domain/quota/days.ts";
import { completeConnect, handleWebhook } from "../../domain/status.ts";
import {
  setHealth,
  useClock,
  useLinkedinClient,
  useRandom,
  useSecretKeys,
} from "../../testing/index.ts";
import { ALWAYS, granted, sender } from "../fixtures/send.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
/** Monday 26 October 2026, 10:00 UTC: the warning; its cool-down ends on Thursday, a weekday. */
const MONDAY = new Date("2026-10-26T10:00:00Z");
const MINUTE_MS = 60_000;
const COOLDOWN_END = new Date(MONDAY.getTime() + 72 * 60 * MINUTE_MS);
let clock = MONDAY;
useClock(() => clock);
let draw = 0.999; // the day's limits are the targets
useRandom(() => draw);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const OWNER = "usr_owner";

type Sender = Awaited<ReturnType<typeof sender>>;

test.beforeEach(() => {
  clock = MONDAY;
  draw = 0.999;
});

/** A connected account of OWNER, of a new workspace or of `workspaceId`, its reference the fake's. */
async function referenced(workspaceId?: string): Promise<Sender & { ref: string }> {
  const settings = { ownerUserId: OWNER, ...(workspaceId === undefined ? {} : { workspaceId }) };
  const account = await sender("UTC", ALWAYS, settings);
  const ref = `fake-account-${account.id}`;
  const data = { providerAccountRefHash: refHash("fake", ref) };
  await app.senderAccount.update({ where: { id: account.id }, data });
  return { ...account, ref };
}

/** The owner's resume of the account at the clock, in its run: its error code, or `resumed`. */
async function resume(account: Sender): Promise<string> {
  try {
    await account.run(() => resumeAccount(OWNER, account.id, clock));
    return "resumed";
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
}

/** The owner's reconnect at the clock: Connect leaves the row pending with its link, which pairs. */
async function reconnect(account: Sender & { ref: string }): Promise<void> {
  const link = `fake-link-${account.id}`;
  const pending = { status: "pending" as const, providerLinkRef: link };
  await app.senderAccount.update({ where: { id: account.id }, data: pending });
  await completeConnect({ providerAccountRef: account.ref, providerRef: link });
}

/** The account's row, its events, oldest first, and its linkedin.account_paused rows. */
async function written(account: Sender) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  const events = await app.senderHealthEvent.findMany({
    where: { senderId: account.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const where = { workspaceId: account.workspaceId, eventName: "linkedin.account_paused" };
  return { row, events, paused: await app.outboxEntry.count({ where }) };
}

/** The account's row of the clock's quota day, made now with the draw as a reservation makes it. */
const today = (account: Sender) =>
  account.run(async () => dayOf(await findAccount(account.id), clock, false));

test("resumeRefusal, in its order: another member; no cool-down; the cool-down not over or with no end; a status not connected; a checkpoint with no pairing since its latest warning; no status checked after the end, or one more than 10 minutes old", () => {
  const changed = new Date("2026-10-26T10:00:00Z");
  const end = new Date("2026-10-29T10:00:00Z");
  const at = new Date("2026-10-29T10:05:00Z");
  const ready: ResumeAccount = {
    ownerUserId: OWNER,
    healthState: "restricted",
    pausedUntil: end,
    status: "connected",
    statusCheckedAt: new Date("2026-10-29T10:01:00Z"),
    connectedAt: new Date("2026-10-01T09:00:00Z"),
  };
  const ago = (minutes: number) => new Date(at.getTime() - minutes * MINUTE_MS);
  const since = new Date(changed.getTime() + MINUTE_MS);
  const late = { pausedUntil: ago(11), statusCheckedAt: ago(10) };
  const stale = { ...late, statusCheckedAt: new Date(ago(10).getTime() - 1_000) };
  const cases: [string, Partial<ResumeAccount>, string | null][] = [
    ["ready", {}, null],
    ["healthy", { healthState: "healthy", pausedUntil: null }, "account_not_paused"],
    ["at_risk", { healthState: "at_risk", pausedUntil: null }, "account_not_paused"],
    ["disconnected", { healthState: "disconnected", pausedUntil: null }, "account_not_paused"],
    ["a minute to go", { pausedUntil: ago(-1) }, "cooldown_active"],
    ["to go, not connected", { pausedUntil: ago(-1), status: "error" }, "cooldown_active"],
    ["no end", { pausedUntil: null }, "cooldown_active"],
    ["at the end", { pausedUntil: at, statusCheckedAt: at }, "status_check_required"],
    ["credentials", { status: "credentials_required" }, "linkedin_account_disconnected"],
    ["checkpoint, paired before", { healthState: "checkpoint" }, "reconnect_required"],
    ["paired at it", { healthState: "checkpoint", connectedAt: changed }, "reconnect_required"],
    ["never paired", { healthState: "checkpoint", connectedAt: null }, "reconnect_required"],
    ["paired since", { healthState: "checkpoint", connectedAt: since }, null],
    ["no status checked", { statusCheckedAt: null }, "status_check_required"],
    ["checked at the end", { statusCheckedAt: end }, "status_check_required"],
    ["10 minutes old", late, null],
    ["and a second", stale, "status_check_required"],
  ];
  for (const [label, change, expected] of cases) {
    assert.equal(resumeRefusal({ ...ready, ...change }, OWNER, at), expected, label);
  }
  const anything = { ...ready, status: "error" as const, statusCheckedAt: null };
  assert.equal(resumeRefusal(anything, "usr_x", at), "not_account_owner", "another member first");
});

test("restricted by its webhook, then a lost session and a reconnect: the cool-down stands; the resume is refused cooldown_active before its end, status_check_required after it until a status is checked; then healthy at half its targets, today's send limits lowered, the events acknowledged by the owner, no mail, and the fleet breaker still on", async () => {
  const account = await referenced();
  const targets = { inviteTarget: 15, messageTarget: 40, rampUpdatedOn: "2026-10-01" };
  await app.senderAccount.update({ where: { id: account.id }, data: targets });
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "restricted"));
  clock = new Date(MONDAY.getTime() + 60 * MINUTE_MS);
  await handleWebhook("fake", fake.emitWebhook("account.disconnected", account.ref));
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  const cooling = await written(account);
  assert.deepEqual(
    [cooling.row.healthState, cooling.row.pausedUntil, cooling.row.status, cooling.paused],
    ["restricted", COOLDOWN_END, "connected", 1],
    "a lost session and a reconnect keep the cool-down; the restriction's mail only",
  );

  clock = new Date(COOLDOWN_END.getTime() - MINUTE_MS);
  assert.equal(await resume(account), "cooldown_active");
  clock = new Date(COOLDOWN_END.getTime() + MINUTE_MS);
  assert.equal(await resume(account), "status_check_required", "checked before the end only");
  const paused = await account.send("refused-message", "message");
  assert.deepEqual(paused, { refused: "account_paused", retryAt: null }, "still paused");

  // Today's row drawn from 15 and 40; a status check after the end, as the vendor reports it.
  const before = await today(account);
  assert.deepEqual([before.inviteLimit, before.messageLimit], [15, 40]);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  clock = new Date(clock.getTime() + 9 * MINUTE_MS);
  draw = 0; // the new draw's low end: 5 of 7, 16 of 20
  assert.equal(await resume(account), "resumed");

  const after = await written(account);
  assert.deepEqual(
    [after.row.healthState, after.row.pausedUntil, after.row.healthChangedAt],
    ["healthy", null, clock],
  );
  assert.deepEqual(
    [after.row.inviteTarget, after.row.messageTarget, after.row.rampUpdatedOn],
    [7, 20, quotaDay(clock, "UTC")],
  );
  const [day] = (await account.days()).filter((row) => row.id === before.id);
  assert.deepEqual(
    [day?.inviteLimit, day?.messageLimit, day?.readAllowance],
    [5, 16, before.readAllowance],
    "today's limits from the halved targets' draw, the read allowance kept",
  );
  const [warning, back] = after.events;
  assert.deepEqual(
    after.events.map((event) => `${event.fromState}>${event.toState}:${event.trigger}`),
    ["healthy>restricted:limit_reached", "restricted>healthy:manual"],
  );
  assert.deepEqual(
    [back?.automaticAction, back?.ackRequired, back?.acknowledgedBy, back?.acknowledgedAt],
    ["resumed", false, OWNER, clock],
  );
  assert.deepEqual([warning?.acknowledgedBy, warning?.acknowledgedAt], [OWNER, clock]);
  assert.equal(after.paused, 1, "no mail for the resume");

  const platform = await app.linkedinPlatformControl.findFirstOrThrow();
  assert.equal(platform.invitesPaused, true, "the breaker stays on");
  const invite = await account.send("after-invite", "invite");
  assert.deepEqual(invite, { refused: "invites_paused", retryAt: null });
  granted(await account.send("after-message", "message"));
});

test("a checkpoint resumes only after the owner's reconnect: a status the vendor reports after the cool-down is not one, reconnect_required; the pairing of Connect's link writes connected_at, and the resume goes", async () => {
  const { workspace } = await createOrganizationWithWorkspace();
  const account = await referenced(workspace.id);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "checkpoint"));
  clock = new Date(COOLDOWN_END.getTime() + MINUTE_MS);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  const checked = await written(account);
  assert.deepEqual([checked.row.statusCheckedAt, checked.row.healthState], [clock, "checkpoint"]);
  assert.equal(await resume(account), "reconnect_required");

  clock = new Date(clock.getTime() + MINUTE_MS);
  await reconnect(account);
  const paired = await written(account);
  assert.deepEqual(
    [paired.row.status, paired.row.connectedAt, paired.row.healthState],
    ["connected", clock, "checkpoint"],
    "a reconnect keeps the cool-down's state",
  );
  assert.equal(await resume(account), "resumed");
  const after = await written(account);
  assert.deepEqual(
    after.events.map((event) => [`${event.fromState}>${event.toState}`, event.acknowledgedBy]),
    [
      ["healthy>checkpoint", OWNER],
      ["checkpoint>healthy", OWNER],
    ],
  );
});

test("a second checkpoint after the owner's reconnect moves the cool-down's end, not health_changed_at: a status the vendor reports after the new end is no reconnect, reconnect_required, until the owner reconnects again", async () => {
  const { workspace } = await createOrganizationWithWorkspace();
  const account = await referenced(workspace.id);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "checkpoint"));
  clock = new Date(MONDAY.getTime() + 60 * MINUTE_MS);
  await reconnect(account);
  clock = new Date(MONDAY.getTime() + 120 * MINUTE_MS);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "checkpoint"));
  const end = new Date(COOLDOWN_END.getTime() + 120 * MINUTE_MS);
  const second = await written(account);
  assert.deepEqual(
    [second.row.healthState, second.row.healthChangedAt, second.row.pausedUntil],
    ["checkpoint", MONDAY, end],
  );
  clock = new Date(end.getTime() + MINUTE_MS);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  assert.equal(await resume(account), "reconnect_required", "the reconnect came before it");
  clock = new Date(clock.getTime() + MINUTE_MS);
  await reconnect(account);
  assert.equal(await resume(account), "resumed");
});

test("targets of 5 and 10 stay as they are, and a stored limit below the new draw stays", async () => {
  const account = await referenced();
  await app.senderAccount.update({ where: { id: account.id }, data: { inviteTarget: 5 } });
  clock = new Date(COOLDOWN_END.getTime() + MINUTE_MS);
  const day = await today(account);
  const low = { inviteLimit: 3, messageLimit: 10 };
  await app.senderQuotaUsage.update({ where: { id: day.id }, data: low });
  await setHealth(account.id, "restricted", { pausedUntil: COOLDOWN_END, at: MONDAY });
  await app.senderAccount.update({ where: { id: account.id }, data: { statusCheckedAt: clock } });

  assert.equal(await resume(account), "resumed");
  const after = await written(account);
  assert.deepEqual([after.row.inviteTarget, after.row.messageTarget], [5, 10]);
  const [kept] = await account.days();
  assert.deepEqual([kept?.inviteLimit, kept?.messageLimit], [3, 10], "never higher than stored");
});

test("two presses at once, each in its own run: the second waits on the account's row, then finds it healthy, account_not_paused; one resume event", async () => {
  const account = await referenced();
  clock = new Date(COOLDOWN_END.getTime() + MINUTE_MS);
  await setHealth(account.id, "checkpoint", { pausedUntil: COOLDOWN_END, at: MONDAY });
  const fresh = { statusCheckedAt: clock, connectedAt: new Date(MONDAY.getTime() + MINUTE_MS) };
  await app.senderAccount.update({ where: { id: account.id }, data: fresh });
  const other = createDbClient("app", { schema: db.schema });
  try {
    const press = (client = app) =>
      account
        .run(() => resumeAccount(OWNER, account.id, clock), client)
        .then(
          () => "resumed",
          (error: unknown) => (isAppError(error) ? error.code : String(error)),
        );
    const answers = await Promise.all([press(), press(other)]);
    assert.deepEqual(answers.sort(), ["account_not_paused", "resumed"]);
  } finally {
    await other.$disconnect();
  }
  const after = await written(account);
  assert.equal(after.row.healthState, "healthy");
  assert.deepEqual(
    after.events.map((event) => `${event.fromState}>${event.toState}`),
    ["checkpoint>healthy"],
  );
});
