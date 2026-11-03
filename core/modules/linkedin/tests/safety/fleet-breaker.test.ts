// The fleet breaker's safety cases (beta-p6-030; docs/security.md "The fleet breaker"), run by
// `pnpm -F @whytide/linkedin test:safety` and not by `test`: one account restricted by its webhook
// stops the next connection request of every account of the instance, in its workspace and in
// another, refused invites_paused, while their messages and reads still reserve; a checkpoint trips
// it the same way, a send's included, and again after a reopen; at_risk and a lost session do not; a
// second warning, and two at once each in its own run, trip it once, with one control event and one
// linkedin.invites_paused; a trip racing the operator's first switch, which makes the platform's
// row, still trips (beta-p6-040); neither the tester's switches, the operator's other switches nor
// an account back to healthy lift it (the owner's resume is beta-p6-040's): only the operator's
// `breaker reopen` does, and the restricted account itself stays paused.
import assert from "node:assert/strict";
import test from "node:test";
import { createDbClient, tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { AppError, newId } from "@whytide/platform";
import { getAdapter, type LinkedinFake, linkedinPort } from "@whytide/providers";
import { runControl } from "../../cli/control.ts";
import { pauseAccount, setWorkspaceStop, unpauseAccount } from "../../domain/controls/controls.ts";
import { applyHealth } from "../../domain/health/apply.ts";
import { refHash } from "../../domain/provider.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { settleFailed } from "../../domain/send/outcome.ts";
import { handleWebhook } from "../../domain/status.ts";
import { ids } from "../../ids.ts";
import { useClock, useLinkedinClient, useRandom } from "../../testing/index.ts";
import { ALWAYS, granted, sender, THURSDAY } from "../fixtures/send.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useClock(() => THURSDAY);
useRandom(() => 0.999); // the day's limits are the targets: 5 connection requests, 10 messages
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const OPERATOR = "ops-anna";
const OPEN = ["granted", "granted", "granted"];
const INVITES_PAUSED = ["invites_paused", "granted", "granted"];

type Sender = Awaited<ReturnType<typeof sender>>;

/** A connected account, of a new workspace or of `workspaceId`, whose reference the fake's webhooks name. */
async function referenced(workspaceId?: string): Promise<Sender & { ref: string }> {
  const account = await sender("UTC", ALWAYS, workspaceId === undefined ? {} : { workspaceId });
  const ref = `fake-account-${account.id}`;
  const data = { providerAccountRefHash: refHash("fake", ref) };
  await app.senderAccount.update({ where: { id: account.id }, data });
  return { ...account, ref };
}

/** Each account's next connection request, message and read: the code it is refused with, or `granted`. */
async function answers(accounts: readonly Sender[], key: string): Promise<string[][]> {
  const code = (answer: object) => ("refused" in answer ? String(answer.refused) : "granted");
  const out: string[][] = [];
  for (const account of accounts) {
    out.push([
      code(await account.send(`${key}-invite-${account.id}`, "invite")),
      code(await account.send(`${key}-message-${account.id}`, "message")),
      code(await account.read()),
    ]);
  }
  return out;
}

/** The platform's row, the invites' control events and the outbox's linkedin.invites_paused, in order. */
async function breaker() {
  const row = await app.linkedinPlatformControl.findFirst();
  const events = await app.linkedinControlEvent.findMany({
    where: { control: "invites" },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const announced = await app.outboxEntry.findMany({
    where: { eventName: "linkedin.invites_paused" },
    orderBy: { id: "asc" },
  });
  return {
    paused: row?.invitesPaused ?? false,
    reason: row?.invitesPausedReason ?? null,
    changedBy: row?.changedBy ?? null,
    sendingOpen: row?.sendingOpen ?? false,
    events: events.map((event) => [
      event.scope,
      event.targetWorkspaceId,
      event.senderAccountId,
      `${event.fromState}>${event.toState}`,
      `${event.actorType}:${event.actor}`,
      event.reason,
    ]),
    announced: announced.map((entry) => [entry.workspaceId, entry.payload]),
  };
}

/** The account's health events' ids, oldest first. */
async function healthEvents(account: Sender): Promise<string[]> {
  const rows = await app.senderHealthEvent.findMany({
    where: { senderId: account.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => row.id);
}

/** The command's exit code and lines, its arguments split at spaces. */
async function control(args: string) {
  const lines: string[] = [];
  const code = await runControl(args.split(" "), (line) => {
    lines.push(line);
  });
  return { code, lines };
}

/** The trip's control event: the system's, naming the account, its workspace and the trigger. */
const tripped = (account: Sender, trigger: string) => [
  "platform",
  account.workspaceId,
  account.id,
  "off>on",
  "system:fleet_breaker",
  trigger,
];
/** The operator's reopen's control event. */
const reopened = ["platform", null, null, "on>off", `operator:${OPERATOR}`, null];

/** A ULID, the part of a platform id after its prefix. */
const ulid = (): string => newId(ids.sender_account).slice(ids.sender_account.length + 1);

/** A connection request of the account's, reserved, whose port call answered `code`, settled in its run. */
async function failedInvite(
  account: Sender,
  code: keyof typeof linkedinPort.errors,
  reason?: string,
) {
  const step = {
    actionType: "invite" as const,
    accountId: account.id,
    stepExecutionId: `sx_${ulid()}`,
    personId: `per_${ulid()}`,
    memberRef: "member-ines",
    idempotencyKey: `step-${ulid()}`,
  };
  const reservationId = granted(await account.send(step.idempotencyKey, step.actionType));
  const details = reason === undefined ? undefined : { details: { reason } };
  const error = new AppError(linkedinPort.errors[code], details);
  await account.run(() => settleFailed(step, reservationId, error));
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

test("one account restricted by its webhook stops the next connection request of every account of the instance, refused invites_paused, while their messages and reads reserve: the platform's row paused by the system with the trigger, one control event naming the account and its workspace, one linkedin.invites_paused", async () => {
  const restricted = await referenced();
  const neighbour = await sender("UTC", ALWAYS, { workspaceId: restricted.workspaceId });
  const elsewhere = await sender();
  assert.deepEqual(await answers([neighbour, elsewhere], "before"), [OPEN, OPEN]);

  await handleWebhook("fake", fake.emitAccountStatus(restricted.ref, "restricted"));
  assert.deepEqual(await answers([neighbour, elsewhere], "after"), [
    INVITES_PAUSED,
    INVITES_PAUSED,
  ]);
  const left = await elsewhere.run(() => remainingToday(elsewhere.id));
  assert.deepEqual([left.invites, left.messages > 0], [0, true], "the plan places no invite");
  const [eventId] = await healthEvents(restricted);
  assert.deepEqual(await breaker(), {
    paused: true,
    reason: "limit_reached",
    changedBy: "system",
    sendingOpen: true,
    events: [tripped(restricted, "limit_reached")],
    announced: [
      [restricted.workspaceId, { sender_account_id: restricted.id, health_event_id: eventId }],
    ],
  });
});

test("a checkpoint trips it the same way, by its webhook and by a send's error, and again after a reopen; at_risk, a lost session by webhook and a send's lost session do not", async () => {
  const other = await sender();
  const atRisk = await sender();
  const risk = { at: THURSDAY, trigger: "acceptance_rate" } as const;
  await atRisk.run(() => applyHealth(tenantClient, atRisk.id, "at_risk", risk));
  const lost = await referenced();
  await handleWebhook("fake", fake.emitWebhook("account.disconnected", lost.ref));
  await failedInvite(await sender(), "linkedin_account_disconnected", "credentials_required");
  assert.deepEqual((await breaker()).events, [], "no trip");
  assert.deepEqual(await answers([other], "untripped"), [OPEN]);

  const checkpointed = await referenced();
  await handleWebhook("fake", fake.emitAccountStatus(checkpointed.ref, "checkpoint"));
  assert.deepEqual(await answers([other], "webhook"), [INVITES_PAUSED]);
  const first = await breaker();
  assert.deepEqual([first.paused, first.reason], [true, "checkpoint"]);
  assert.deepEqual(first.events, [tripped(checkpointed, "checkpoint")]);

  assert.equal((await control(`breaker reopen --operator ${OPERATOR}`)).code, 0);
  assert.deepEqual(await answers([other], "reopened"), [OPEN]);
  const sent = await sender();
  await failedInvite(sent, "linkedin_account_disconnected", "checkpoint");
  assert.deepEqual(await answers([other], "send"), [INVITES_PAUSED]);
  const second = await breaker();
  assert.deepEqual([second.paused, second.reason], [true, "checkpoint"]);
  assert.deepEqual(second.events, [
    tripped(checkpointed, "checkpoint"),
    reopened,
    tripped(sent, "checkpoint"),
  ]);
  const [sentEventId] = await healthEvents(sent);
  assert.deepEqual(second.announced.at(-1), [
    sent.workspaceId,
    { sender_account_id: sent.id, health_event_id: sentEventId },
  ]);
  assert.equal(second.announced.length, 2, "one per trip");
});

test("a second warning, and two at once each in its own run on its own connection, trip it once: one control event and one linkedin.invites_paused, the first trip's trigger kept", async () => {
  const [a, b, c] = [await sender(), await sender(), await sender()];
  const clients = [0, 1].map(() => createDbClient("app", { schema: db.schema }));
  const warnings = [
    [a, "restricted", "limit_reached"],
    [b, "checkpoint", "checkpoint"],
  ] as const;
  try {
    await Promise.all(
      warnings.map(([account, signal, trigger], n) => {
        const cause = { at: THURSDAY, trigger };
        return account.run(() => applyHealth(tenantClient, account.id, signal, cause), clients[n]);
      }),
    );
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
  const once = await breaker();
  assert.equal(once.events.length, 1, "one control event");
  assert.equal(once.announced.length, 1, "one linkedin.invites_paused");
  const [winner] = [a, b].filter((account) => once.events[0]?.[2] === account.id);
  assert.ok(winner, "the event names one of the two");
  assert.deepEqual(once.events[0]?.[5], once.reason, "the row's reason is the event's");
  const [winnerEvent] = await healthEvents(winner);
  assert.deepEqual(once.announced[0]?.[1], {
    sender_account_id: winner.id,
    health_event_id: winnerEvent,
  });

  const later = { at: THURSDAY, trigger: "limit_reached" } as const;
  await c.run(() => applyHealth(tenantClient, c.id, "restricted", later));
  assert.deepEqual(await breaker(), once, "the second warning trips nothing more");
});

test("a trip whose update finds no platform row while the operator's first switch makes one still trips: its insert waits for the switch's commit and makes nothing, and the update, run again, pauses the switch's row", async () => {
  const account = await referenced();
  await asRole("owner").linkedinPlatformControl.deleteMany({});
  const locked = Promise.withResolvers<number>();
  const released = Promise.withResolvers<void>();
  const other = createDbClient("app", { schema: db.schema });
  try {
    const switching = other.$transaction(async (tx) => {
      const data = { sendingOpen: true, changedBy: OPERATOR, changedAt: THURSDAY };
      await tx.linkedinPlatformControl.create({
        data: { id: newId(ids.linkedin_platform_control), ...data },
      });
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked.resolve(row?.pid ?? 0);
      await released.promise;
    });
    const holder = await locked.promise;
    const warning = handleWebhook("fake", fake.emitAccountStatus(account.ref, "restricted"));
    await blockedBy(holder);
    released.resolve();
    await switching;
    await warning;
  } finally {
    await other.$disconnect();
  }
  const [eventId] = await healthEvents(account);
  assert.deepEqual(await breaker(), {
    paused: true,
    reason: "limit_reached",
    changedBy: "system",
    sendingOpen: true,
    events: [tripped(account, "limit_reached")],
    announced: [[account.workspaceId, { sender_account_id: account.id, health_event_id: eventId }]],
  });
});

test("only the operator's breaker reopen lifts it: the tester's pause and unpause, the workspace's stop and its lift, the operator's sending and platform switches and an account back to healthy leave invites paused; the reopen opens them with its event, and the restricted account stays paused", async () => {
  const restricted = await referenced();
  await handleWebhook("fake", fake.emitAccountStatus(restricted.ref, "restricted"));
  const other = await sender();
  const { ownerUserId } = await app.senderAccount.findUniqueOrThrow({ where: { id: other.id } });
  await other.run(() => pauseAccount(other.id, ownerUserId));
  await other.run(() => unpauseAccount(other.id, ownerUserId));
  await other.run(() => setWorkspaceStop(true, ownerUserId));
  await other.run(() => setWorkspaceStop(false, ownerUserId));
  for (const args of ["sending close", "sending open", "stop --platform", "start --platform"]) {
    assert.equal((await control(`${args} --operator ${OPERATOR}`)).code, 0, args);
  }
  const back = await referenced();
  await handleWebhook("fake", fake.emitWebhook("account.disconnected", back.ref));
  await handleWebhook("fake", fake.emitAccountStatus(back.ref, "connected"));
  const healthy = await app.senderAccount.findUniqueOrThrow({ where: { id: back.id } });
  assert.equal(healthy.healthState, "healthy", "a reconnect is a health change into healthy");
  assert.deepEqual(await answers([other, back], "held"), [INVITES_PAUSED, INVITES_PAUSED]);
  const held = await breaker();
  assert.deepEqual([held.paused, held.reason], [true, "limit_reached"]);

  assert.deepEqual(await control(`breaker reopen --operator ${OPERATOR}`), {
    code: 0,
    lines: ["changed: invites open"],
  });
  const open = await breaker();
  assert.deepEqual(
    [open.paused, open.reason, open.changedBy, open.events],
    [false, null, OPERATOR, [tripped(restricted, "limit_reached"), reopened]],
  );
  assert.deepEqual(await answers([other, back], "open"), [OPEN, OPEN]);
  const paused = ["account_paused", "account_paused", "account_paused"];
  assert.deepEqual(await answers([restricted], "own"), [paused], "its own pause stays");
});
