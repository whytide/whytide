// The safety cases of the account's health (beta-p6-010; docs/security.md "Account health"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: each warning, a restricted or a
// checkpoint webhook, a send's linkedin_limit_reached or linkedin_account_disconnected by reason, a
// read's, pauses the account in the run of its cause, and the next send of every type and the next
// read are refused account_paused; a lost session too, and its reconnect lifts it. A cool-down
// survives a disconnect and a reconnect (C26), and never moves earlier. The third rate limit or
// provider error in an hour, sends and reads together, pauses sends and reads until the next working
// day, with the state, the cool-down and the switches untouched; two do nothing. It counts calls, not
// attempts: the failed attempts of one send or of one read are one. An at_risk account
// is refused its invites and keeps its messages and reads. A pause releases the account's open send
// slots but keeps one held for a send whose outcome is unknown, so that its late commit never puts
// the day over its limit after a reconnect, and leaves one a commit settled while it waited.
import assert from "node:assert/strict";
import test from "node:test";
import { createDbClient, tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { AppError, newId } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { logAction } from "../../domain/action-log/log.ts";
import { afterPortError } from "../../domain/health/signals.ts";
import { refHash } from "../../domain/provider.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { settleFailed } from "../../domain/send/outcome.ts";
import { commitSend } from "../../domain/send/settle.ts";
import type { Step } from "../../domain/send/step.ts";
import { handleWebhook } from "../../domain/status.ts";
import { ids } from "../../ids.ts";
import {
  setHealth,
  setPlatformControls,
  useClock,
  useLinkedinClient,
  useRandom,
} from "../../testing/index.ts";
import { granted, sender, THURSDAY } from "../fixtures/send.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let clock = THURSDAY;
useClock(() => clock);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const MINUTE_MS = 60_000;
const COOLDOWN_END = new Date(THURSDAY.getTime() + 72 * 60 * MINUTE_MS);
/** Friday 23 October 2026, 00:00 UTC: the start of the account's next working day. */
const FRIDAY = new Date("2026-10-23T00:00:00Z");
const PAUSED = ["account_paused", null];
const NOTHING = { invites: 0, messages: 0, withdrawals: 0, actions: 0, windowEnd: null };

type Sender = Awaited<ReturnType<typeof sender>>;
type PortCode = keyof typeof linkedinPort.errors;

test.beforeEach(() => {
  clock = THURSDAY;
});

/** A connected account whose reference the fake's webhooks name. */
async function referenced(): Promise<Sender & { ref: string }> {
  const account = await sender();
  const ref = `fake-account-${account.id}`;
  const data = { providerAccountRefHash: refHash("fake", ref) };
  await app.senderAccount.update({ where: { id: account.id }, data });
  return { ...account, ref };
}

/** The refusal of a send of each type and of a read, each `[code, retryAt]`. */
async function refusals(account: Sender, key: string) {
  const answers = [
    await account.send(`${key}-invite`, "invite"),
    await account.send(`${key}-message`, "message"),
    await account.send(`${key}-withdraw`, "withdraw"),
    await account.read(),
  ];
  return answers.map((answer) =>
    "refused" in answer ? [answer.refused, answer.retryAt] : ["granted", null],
  );
}

/** The account's health, cool-down and retry_at, and its events: `from>to`, trigger, action, end. */
async function health(account: Sender) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  const events = await app.senderHealthEvent.findMany({
    where: { senderId: account.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    state: row.healthState,
    pausedUntil: row.pausedUntil,
    retryAt: row.retryAt,
    events: events.map((event) => [
      `${event.fromState}>${event.toState}`,
      event.trigger,
      event.automaticAction,
      event.pausedUntil,
    ]),
  };
}

/** A new ULID, the part of a platform id after its prefix. */
const ulid = (): string => newId(ids.sender_account).slice(ids.sender_account.length + 1);

/** A step of the account's, as its request file holds it, under a key of its own. */
function stepOf(account: Sender): Step {
  return {
    actionType: "invite",
    accountId: account.id,
    stepExecutionId: `sx_${ulid()}`,
    personId: `per_${ulid()}`,
    memberRef: "member-ines",
    idempotencyKey: `step-${ulid()}`,
  };
}

/** The reservations' statuses, in the order given. */
async function statuses(...reservationIds: string[]) {
  const rows = await app.senderQuotaReservation.findMany({
    where: { id: { in: reservationIds } },
    select: { id: true, status: true },
  });
  return reservationIds.map((id) => rows.find((row) => row.id === id)?.status);
}

/** Resolves once a transaction waits on the backend `pid`'s locks; five seconds at most. */
async function blockedBy(pid: number): Promise<void> {
  for (let waited = 0; ; waited += 1) {
    const [blocked] = await asRole("owner").$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if ((blocked?.n ?? 0) > 0) return;
    assert.ok(waited < 200, `nothing waited on backend ${pid}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A send reserved and its port call failed with `code`, settled in the send's run: a new step's, or
 * an attempt of `step`.
 */
async function failSend(
  account: Sender,
  code: PortCode,
  details?: Record<string, unknown>,
  step = stepOf(account),
) {
  const reservationId = granted(await account.send(step.idempotencyKey, step.actionType));
  const error = new AppError(linkedinPort.errors[code], details && { details });
  return account.run(() => settleFailed(step, reservationId, error));
}

/**
 * A read's port call failed with `code`, logged and answered in the read's run, as the read
 * activities do: an attempt of the read whose file key is `callRef`, or a call of its own.
 */
async function failRead(
  account: Sender,
  code: PortCode,
  details?: Record<string, unknown>,
  callRef?: string,
) {
  const error = new AppError(linkedinPort.errors[code], details && { details });
  const row = {
    accountId: account.id,
    kind: "read_profile" as const,
    count: 1,
    outcome: code,
    callRef,
  };
  await account.run(async () => {
    await logAction(row);
    await afterPortError(account.id, error, clock);
  });
}

test("a restricted and a checkpoint webhook each pause the account in the webhook's run: the state, its cool-down 72 hours on and one health event with its trigger; the next send of every type and the next read are refused account_paused with no time, and remainingToday places nothing", async () => {
  for (const [status, trigger] of [
    ["restricted", "limit_reached"],
    ["checkpoint", "checkpoint"],
  ] as const) {
    const account = await referenced();
    granted(await account.read());
    await handleWebhook("fake", fake.emitAccountStatus(account.ref, status));
    assert.deepEqual(await health(account), {
      state: status,
      pausedUntil: COOLDOWN_END,
      retryAt: null,
      events: [[`healthy>${status}`, trigger, "paused_all_actions", COOLDOWN_END]],
    });
    assert.deepEqual(await refusals(account, status), [PAUSED, PAUSED, PAUSED, PAUSED]);
    assert.deepEqual(await account.run(() => remainingToday(account.id)), NOTHING);
  }
});

test("a send's warning pauses the account in the send's run: linkedin_limit_reached restricted (limit_reached); linkedin_account_disconnected with reason checkpoint checkpoint, restricted restricted (limit_reached), credentials_required, disconnected or none disconnected (session_invalid); a read's alike; the next send and read are refused account_paused", async () => {
  const cases = [
    ["linkedin_limit_reached", undefined, "restricted", "limit_reached"],
    ["linkedin_account_disconnected", { reason: "checkpoint" }, "checkpoint", "checkpoint"],
    ["linkedin_account_disconnected", { reason: "restricted" }, "restricted", "limit_reached"],
    [
      "linkedin_account_disconnected",
      { reason: "credentials_required" },
      "disconnected",
      "session_invalid",
    ],
    [
      "linkedin_account_disconnected",
      { reason: "disconnected" },
      "disconnected",
      "session_invalid",
    ],
    ["linkedin_account_disconnected", undefined, "disconnected", "session_invalid"],
  ] as const;
  for (const fail of [failSend, failRead]) {
    for (const [code, details, state, trigger] of cases) {
      // The fleet breaker the case before tripped, lifted as the operator's reopen leaves it, so that
      // each case's invite reserves (tests/safety/fleet-breaker.test.ts).
      await setPlatformControls({ invitesPaused: false });
      const account = await sender();
      await fail(account, code, details);
      const label = `${fail.name} ${code} ${details?.reason ?? "no reason"}`;
      const after = await health(account);
      assert.deepEqual(
        [after.state, after.events.map((event) => event.slice(0, 3))],
        [state, [[`healthy>${state}`, trigger, "paused_all_actions"]]],
        label,
      );
      assert.deepEqual(await refusals(account, label), [PAUSED, PAUSED, PAUSED, PAUSED], label);
    }
  }
});

test("a lost session by webhook, account.disconnected or credentials_required, sets disconnected with its event and refuses the next send and read; the reconnect returns it to healthy (manual) and both reserve again", async () => {
  for (const kind of ["account.disconnected", "account.credentials_required"] as const) {
    const account = await referenced();
    await handleWebhook("fake", fake.emitWebhook(kind, account.ref));
    const lost = await health(account);
    assert.deepEqual(lost.state, "disconnected", kind);
    const refused = ["linkedin_account_disconnected", null];
    assert.deepEqual(await refusals(account, kind), [refused, refused, refused, refused], kind);
    await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
    const back = await health(account);
    assert.deepEqual(back.events, [
      ["healthy>disconnected", "session_invalid", "paused_all_actions", null],
      ["disconnected>healthy", "manual", "resumed", null],
    ]);
    granted(await account.send(`${kind}-back`, "message"));
    granted(await account.read());
  }
});

test("C26: restricted, then a disconnect and a reconnect, by webhook, leave the account restricted with the same cool-down and refused; a later warning moves the cool-down on with no new event, an earlier one leaves it; a checkpoint over it is a new event that keeps the later end", async () => {
  const account = await referenced();
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "restricted"));
  await handleWebhook("fake", fake.emitWebhook("account.disconnected", account.ref));
  await handleWebhook("fake", fake.emitWebhook("account.credentials_required", account.ref));
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  const after = await health(account);
  assert.deepEqual([after.state, after.pausedUntil], ["restricted", COOLDOWN_END]);
  assert.equal(after.events.length, 1, "no event for the session's crossings");
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.equal(row.status, "connected", "the session is back; the cool-down is not");
  assert.deepEqual(await refusals(account, "c26"), [PAUSED, PAUSED, PAUSED, PAUSED]);

  clock = new Date(THURSDAY.getTime() + 5 * 60 * MINUTE_MS);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "restricted"));
  const moved = new Date(clock.getTime() + 72 * 60 * MINUTE_MS);
  assert.deepEqual((await health(account)).pausedUntil, moved);
  clock = THURSDAY;
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "restricted"));
  assert.deepEqual((await health(account)).pausedUntil, moved, "never earlier");
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "checkpoint"));
  const checkpoint = await health(account);
  assert.deepEqual([checkpoint.state, checkpoint.pausedUntil], ["checkpoint", moved]);
  assert.deepEqual(checkpoint.events.at(-1), [
    "restricted>checkpoint",
    "checkpoint",
    "paused_all_actions",
    moved,
  ]);
  assert.equal(checkpoint.events.length, 2);
});

test("the third linkedin_rate_limited or linkedin_provider_error within 60 minutes, sends and reads together, sets retry_at to the next working day's start with one health event (rate_limit_errors, the count) and leaves the state, the cool-down and the switches; sends and reads are refused until then; two, or one an hour old, do nothing", async () => {
  const account = await sender();
  const old = { accountId: account.id, kind: "read_engagers", count: 1 } as const;
  clock = new Date(THURSDAY.getTime() - 61 * MINUTE_MS);
  await account.run(() => logAction({ ...old, outcome: "linkedin_provider_error" }));
  clock = THURSDAY;
  await failSend(account, "linkedin_rate_limited", { retryAfterSec: 60 });
  clock = new Date(THURSDAY.getTime() + 10 * MINUTE_MS);
  await failRead(account, "linkedin_provider_error");
  const two = await health(account);
  assert.deepEqual(two.events, [], "two errors do nothing");
  assert.deepEqual(two.retryAt, new Date(THURSDAY.getTime() + MINUTE_MS), "the rate limit's own");

  clock = new Date(THURSDAY.getTime() + 20 * MINUTE_MS);
  await failSend(account, "linkedin_provider_error");
  const three = await health(account);
  assert.deepEqual(three, {
    state: "healthy",
    pausedUntil: null,
    retryAt: FRIDAY,
    events: [["healthy>healthy", "rate_limit_errors", "paused_all_actions", FRIDAY]],
  });
  const [event] = await app.senderHealthEvent.findMany({ where: { senderId: account.id } });
  assert.deepEqual([event?.metrics, event?.ackRequired], [{ errors: 3, windowMinutes: 60 }, false]);
  const controls = await app.linkedinPlatformControl.findFirstOrThrow();
  assert.deepEqual(
    [controls.sendingOpen, controls.stopped, controls.invitesPaused],
    [true, false, false],
  );
  const limited = ["rate_limited", FRIDAY];
  assert.deepEqual(await refusals(account, "third"), [limited, limited, limited, limited]);
  assert.deepEqual(await account.run(() => remainingToday(account.id)), NOTHING);

  clock = new Date(THURSDAY.getTime() + 30 * MINUTE_MS);
  await failRead(account, "linkedin_rate_limited");
  assert.equal((await health(account)).events.length, 1, "a fourth adds no event");
});

test("the third error counts calls, not attempts (the coordinator's decision for the owner, 2026-10-30): one send's three rate limits, then one read's three provider errors, each one call, pause nothing; a third call within the hour pauses the account until its next working day, its event counting three", async () => {
  const account = await sender();
  const step = stepOf(account);
  for (const minutes of [0, 2, 4]) {
    clock = new Date(THURSDAY.getTime() + minutes * MINUTE_MS);
    await failSend(account, "linkedin_rate_limited", { retryAfterSec: 60 }, step);
  }
  assert.deepEqual((await health(account)).events, [], "one send's attempts: one call");
  const profile = (n: number) => `raw/signals/run-1/profiles/candidate-${n}.json`;
  for (const minutes of [6, 7, 8]) {
    clock = new Date(THURSDAY.getTime() + minutes * MINUTE_MS);
    await failRead(account, "linkedin_provider_error", undefined, profile(1));
  }
  const two = await health(account);
  assert.deepEqual(two.events, [], "one read's attempts: one call, two in all");
  assert.deepEqual(
    two.retryAt,
    new Date(THURSDAY.getTime() + 5 * MINUTE_MS),
    "the rate limit's own",
  );
  const outcome = { in: ["linkedin_rate_limited", "linkedin_provider_error"] };
  const rows = await app.senderActionLog.findMany({
    where: { senderAccountId: account.id, outcome },
  });
  assert.deepEqual(
    rows.map((row) => row.callRef).sort(),
    [...Array(3).fill(profile(1)), ...Array(3).fill(step.stepExecutionId)].sort(),
  );

  clock = new Date(THURSDAY.getTime() + 10 * MINUTE_MS);
  await failRead(account, "linkedin_provider_error", undefined, profile(2));
  const three = await health(account);
  assert.deepEqual(
    [three.retryAt, three.events],
    [FRIDAY, [["healthy>healthy", "rate_limit_errors", "paused_all_actions", FRIDAY]]],
  );
  const [event] = await app.senderHealthEvent.findMany({ where: { senderId: account.id } });
  assert.deepEqual(event?.metrics, { errors: 3, windowMinutes: 60 }, "calls, not rows");
});

test("an at_risk account is refused its invites, invites_paused with no time, and keeps its messages, withdrawals and reads; remainingToday places no invite", async () => {
  const account = await sender();
  await setHealth(account.id, "at_risk");
  assert.deepEqual(await refusals(account, "at-risk"), [
    ["invites_paused", null],
    ["granted", null],
    ["granted", null],
    ["granted", null],
  ]);
  const left = await account.run(() => remainingToday(account.id));
  assert.deepEqual([left.invites, left.messages > 0], [0, true]);
  assert.notEqual(left.windowEnd, null);
});

test("a pause keeps the slot of a send whose outcome is unknown for its check and releases the open one: after a disconnect and a reconnect the same day, the day's connection requests reach their limit with it, and its late commit never passes the limit", async () => {
  const account = await referenced();
  const step = stepOf(account);
  const unknown = granted(await account.send(step.idempotencyKey, step.actionType));
  const open = granted(await account.send("open-invite", "invite"));
  const error = new AppError(linkedinPort.errors.linkedin_provider_error);
  await account.run(() => settleFailed(step, unknown, error));
  await handleWebhook("fake", fake.emitWebhook("account.disconnected", account.ref));
  assert.deepEqual(await statuses(unknown, open), ["reserved", "released"]);
  await handleWebhook("fake", fake.emitAccountStatus(account.ref, "connected"));
  assert.equal((await health(account)).state, "healthy");

  clock = new Date(THURSDAY.getTime() + 61 * MINUTE_MS); // past the hour's retry_at, the same day
  const [day] = await account.days();
  assert.ok(day);
  const again: string[] = [];
  for (let n = 0; n <= day.inviteLimit; n += 1) {
    const answer = await account.send(`again-${n}`, "invite");
    if (!("reservationId" in answer)) {
      assert.equal(answer.refused, "invite_cap_reached");
      break;
    }
    again.push(answer.reservationId);
  }
  assert.equal(again.length, day.inviteLimit - 1, "the kept slot still counts");
  // The check finds the send out after all: its commit, then the others'.
  for (const reservationId of [unknown, ...again]) await account.commit(reservationId);
  const [after] = await account.days();
  assert.deepEqual([after?.invitesReserved, after?.invitesCommitted], [0, day.inviteLimit]);
});

test("a send's commit that settles its slot while the pause waits for the day's lock: the pause leaves the slot as it is and the warning commits with its event; the send counts once", async () => {
  const account = await referenced();
  // A message: an invite's commit locks the account's row first (beta-p4-070), so the pause would
  // wait there and list the slot settled; a message's meets it at the day's lock, listed open.
  const reservationId = granted(await account.send("committing", "message"));
  let locked: (pid: number) => void = () => {};
  const pid = new Promise<number>((resolve) => {
    locked = resolve;
  });
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const other = createDbClient("app", { schema: db.schema });
  try {
    const committing = account.run(async () => {
      await commitSend(reservationId);
      const [row] = await tenantClient.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked(row?.pid ?? 0);
      await released;
    }, other);
    const holder = await pid;
    const warning = handleWebhook("fake", fake.emitWebhook("account.disconnected", account.ref));
    await blockedBy(holder);
    release();
    await committing;
    await warning;
  } finally {
    await other.$disconnect();
  }
  const after = await health(account);
  assert.deepEqual(
    [after.state, after.events.map((event) => event[0])],
    ["disconnected", ["healthy>disconnected"]],
  );
  assert.deepEqual(await statuses(reservationId), ["committed"]);
  const [day] = await account.days();
  assert.deepEqual([day?.messagesReserved, day?.messagesCommitted], [0, 1]);
});
