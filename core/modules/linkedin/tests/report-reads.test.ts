// The two reads campaigns' "Done when" report makes (beta-p7-020; README.md "Public interface"), in
// this file's schema of the worktree's database, each in a tenant run with another workspace's rows
// present: sendLogRows answers the `ok` rows of the sends (invite, message, withdraw) at or after
// `since`, oldest first, a row naming no step execution as null; healthEventsSince answers the events
// into restricted or checkpoint at or after `since`. Neither answers another workspace's rows.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { sendLogRows } from "../domain/action-log/sends.ts";
import { healthEventsSince } from "../domain/health/events.ts";
import type { HealthState, HealthTrigger } from "../domain/health/states.ts";
import { ids } from "../ids.ts";
import type { ActionOutcome, actionKinds } from "../schemas/quota.ts";
import { createConnectedAccount, useLinkedinClient } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_test");
const A = "wsp_report_reads_a";
const B = "wsp_report_reads_b";
const MINUTE_MS = 60_000;
const SINCE = new Date("2026-10-01T00:00:00Z");
/** `minutes` after SINCE; a negative number before it. */
const at = (minutes: number) => new Date(SINCE.getTime() + minutes * MINUTE_MS);
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
/** A step execution's id, as campaigns makes one: its prefix is campaigns' to register. */
const step = () => `sx_${newId(ids.sender_action_log).slice("sal_".length)}`;

/** A row written straight to the table, as linkedin's writers leave one: its id. */
async function logRow(
  workspaceId: string,
  senderAccountId: string,
  row: {
    kind: (typeof actionKinds)[number];
    outcome: ActionOutcome;
    objectRef?: string | null;
    at: Date;
  },
): Promise<string> {
  const id = newId(ids.sender_action_log);
  const { kind, outcome, objectRef = null } = row;
  await app.senderActionLog.create({
    data: { id, workspaceId, senderAccountId, kind, outcome, objectRef, count: 1, at: row.at },
  });
  return id;
}

/** A health event written straight to the table, as applyHealth records one: its id. */
async function healthEvent(
  workspaceId: string,
  senderId: string,
  event: { from: HealthState; to: HealthState; trigger: HealthTrigger; at: Date },
): Promise<string> {
  const id = newId(ids.sender_health_event);
  await app.senderHealthEvent.create({
    data: {
      ...{ id, workspaceId, senderId, fromState: event.from, toState: event.to },
      ...{ trigger: event.trigger, metrics: {}, createdAt: event.at },
    },
  });
  return id;
}

test("sendLogRows answers the workspace's ok rows of invites, messages and withdrawals since `since`, oldest first, a row naming no step as null", async () => {
  const { id: account } = await createConnectedAccount(A);
  const { id: other } = await createConnectedAccount(B);
  const [invite, message, withdraw] = [step(), step(), step()];
  const ok = (kind: "invite" | "message" | "withdraw", objectRef: string | null, minutes: number) =>
    logRow(A, account, { kind, outcome: "ok", objectRef, at: at(minutes) });
  const before = await ok("invite", step(), -1);
  const sentWithdraw = await ok("withdraw", withdraw, 30);
  const sentInvite = await ok("invite", invite, 0);
  const sentMessage = await ok("message", message, 20);
  const noStep = await ok("message", null, 25);
  const person = await ok("message", "per_01JABCDEFGHJKMNPQRSTVWXYZ0", 26);
  // Not a send that went out: a reservation, a refusal, a port's error, a read, a check.
  await logRow(A, account, { kind: "invite", outcome: "reserved", at: at(1) });
  await logRow(A, account, { kind: "message", outcome: "rate_limited", at: at(2) });
  const failed = { kind: "invite", outcome: "linkedin_provider_error", objectRef: invite } as const;
  await logRow(A, account, { ...failed, at: at(3) });
  const read = {
    kind: "read_profile",
    outcome: "ok",
    objectRef: "per_01JABCDEFGHJKMNPQRSTVWX01",
  } as const;
  await logRow(A, account, { ...read, at: at(4) });
  await logRow(A, account, { kind: "send_check", outcome: "ok", objectRef: invite, at: at(5) });
  // Another workspace's send.
  await logRow(B, other, { kind: "invite", outcome: "ok", objectRef: step(), at: at(10) });

  const rows = await run(A, () => sendLogRows({ since: SINCE }));
  assert.deepEqual(
    rows.map(({ id, stepExecutionId, senderAccountId, kind, at }) => [
      ...[id, stepExecutionId, senderAccountId, kind, at.toISOString()],
    ]),
    [
      [sentInvite, invite, account, "invite", at(0).toISOString()],
      [sentMessage, message, account, "message", at(20).toISOString()],
      [noStep, null, account, "message", at(25).toISOString()],
      [person, null, account, "message", at(26).toISOString()],
      [sentWithdraw, withdraw, account, "withdraw", at(30).toISOString()],
    ],
  );
  const all = await run(A, () => sendLogRows({ since: at(-60) }));
  assert.equal(all[0]?.id, before, "a row before `since` is in an earlier period");
  assert.deepEqual(
    (await run(B, () => sendLogRows({ since: SINCE }))).map(
      ({ senderAccountId }) => senderAccountId,
    ),
    [other],
  );
  await assert.rejects(
    run(A, () => sendLogRows({ since: "yesterday" as unknown as Date })),
    {
      code: "read_input_invalid",
      details: { fields: ["since"] },
    },
  );
});

test("healthEventsSince answers the workspace's events into restricted or checkpoint since `since`, oldest first", async () => {
  const { id: account } = await createConnectedAccount(A);
  const { id: other } = await createConnectedAccount(B);
  await healthEvent(A, account, {
    from: "healthy",
    to: "restricted",
    trigger: "manual",
    at: at(-1),
  });
  const restricted = await healthEvent(A, account, {
    ...{ from: "healthy", to: "restricted", trigger: "limit_reached" },
    at: at(40),
  });
  const checkpoint = await healthEvent(A, account, {
    ...{ from: "healthy", to: "checkpoint", trigger: "checkpoint" },
    at: at(10),
  });
  // Not a warning: a risk, a lost session, a recovery.
  await healthEvent(A, account, {
    from: "healthy",
    to: "at_risk",
    trigger: "acceptance_rate",
    at: at(20),
  });
  await healthEvent(A, account, {
    from: "healthy",
    to: "disconnected",
    trigger: "session_invalid",
    at: at(30),
  });
  await healthEvent(A, account, {
    from: "checkpoint",
    to: "healthy",
    trigger: "manual",
    at: at(50),
  });
  // Another workspace's restriction.
  await healthEvent(B, other, {
    from: "healthy",
    to: "restricted",
    trigger: "limit_reached",
    at: at(5),
  });

  const events = await run(A, () => healthEventsSince({ since: SINCE }));
  assert.deepEqual(events, [
    {
      id: checkpoint,
      senderAccountId: account,
      toState: "checkpoint",
      trigger: "checkpoint",
      createdAt: at(10),
    },
    {
      id: restricted,
      senderAccountId: account,
      toState: "restricted",
      trigger: "limit_reached",
      createdAt: at(40),
    },
  ]);
  assert.deepEqual(
    (await run(B, () => healthEventsSince({ since: SINCE }))).map(
      ({ senderAccountId }) => senderAccountId,
    ),
    [other],
  );
  await assert.rejects(
    run(A, () => healthEventsSince({ since: "" as unknown as Date })),
    {
      code: "read_input_invalid",
      details: { fields: ["since"] },
    },
  );
});
