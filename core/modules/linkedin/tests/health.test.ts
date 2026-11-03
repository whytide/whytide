// The account's health (beta-p6-010; README.md "Health"): applyHealth's table, every signal from
// every state, on the database, with its event, its outbox event and its cool-down; a cool-down never
// moved earlier; the user's own disconnect, which changes no health; the open send reservations a
// pause releases, and a send past its re-read that still commits; healthSignalOf for each code and
// reason, against the error map's account column; the next working day; and two third errors at
// once that give one event.
import assert from "node:assert/strict";
import test from "node:test";
import { createDbClient, tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { linkedinPort } from "@whytide/providers";
import { disconnect } from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import { applyHealth } from "../domain/health/apply.ts";
import { healthSignalOf, nextWorkingDayAt, pauseOnThirdError } from "../domain/health/signals.ts";
import type { HealthSignal, HealthState } from "../domain/health/states.ts";
import { SEND_ERROR_MAP, sendAnswerOf } from "../domain/send/error-map.ts";
import { setHealth, useClock, useLinkedinClient, useRandom } from "../testing/index.ts";
import { granted, sender, THURSDAY } from "./fixtures/send.ts";

const db = withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useClock(() => THURSDAY);
useRandom(() => 0.999);
const HOUR_MS = 3_600_000;
const COOLDOWN_END = new Date(THURSDAY.getTime() + 72 * HOUR_MS);
/** A cool-down that ends before the one a signal at THURSDAY gives. */
const EARLIER_END = new Date(THURSDAY.getTime() + HOUR_MS);
const STATES: HealthState[] = ["healthy", "at_risk", "restricted", "checkpoint", "disconnected"];
const TRIGGERS = {
  restricted: "limit_reached",
  checkpoint: "checkpoint",
  disconnected: "session_invalid",
  reconnected: "manual",
  at_risk: "acceptance_rate",
  recovered: "acceptance_rate",
  resumed: "manual",
} as const satisfies Record<HealthSignal, string>;
/** Every signal from every state: the state it moves to, `extend` (the cool-down moves on), or null. */
const TABLE: Record<HealthState, Record<HealthSignal, HealthState | "extend" | null>> = {
  healthy: {
    restricted: "restricted",
    checkpoint: "checkpoint",
    disconnected: "disconnected",
    reconnected: null,
    at_risk: "at_risk",
    recovered: null,
    resumed: null,
  },
  at_risk: {
    restricted: "restricted",
    checkpoint: "checkpoint",
    disconnected: "disconnected",
    reconnected: null,
    at_risk: null,
    recovered: "healthy",
    resumed: null,
  },
  restricted: {
    restricted: "extend",
    checkpoint: "checkpoint",
    disconnected: null,
    reconnected: null,
    at_risk: null,
    recovered: null,
    resumed: "healthy",
  },
  checkpoint: {
    restricted: "extend",
    checkpoint: "extend",
    disconnected: null,
    reconnected: null,
    at_risk: null,
    recovered: null,
    resumed: "healthy",
  },
  disconnected: {
    restricted: "restricted",
    checkpoint: "checkpoint",
    disconnected: null,
    reconnected: "healthy",
    at_risk: null,
    recovered: null,
    resumed: null,
  },
};
const ACTION = {
  healthy: "resumed",
  at_risk: "paused_invites",
  restricted: "paused_all_actions",
  checkpoint: "paused_all_actions",
  disconnected: "paused_all_actions",
} as const;
const cooling = (state: HealthState) => state === "restricted" || state === "checkpoint";

type Sender = Awaited<ReturnType<typeof sender>>;

/** The account's health columns, its events and its linkedin.account_paused events. */
async function written(account: Sender) {
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  const events = await app.senderHealthEvent.findMany({ where: { senderId: account.id } });
  const outbox = await app.outboxEntry.findMany({
    where: { workspaceId: account.workspaceId, eventName: "linkedin.account_paused" },
  });
  return { row, events, outbox };
}

test("applyHealth, every signal from every state: the table's state, health_changed_at, the cool-down 72 hours on in restricted and checkpoint and null otherwise, one event with its trigger, action and acknowledgement, and linkedin.account_paused for every change but into healthy; extend moves the cool-down only; the rest change nothing", async () => {
  for (const state of STATES) {
    for (const [signal, expected] of Object.entries(TABLE[state]) as [HealthSignal, string][]) {
      const label = `${signal} in ${state}`;
      const account = await sender();
      const pausedUntil = cooling(state) ? EARLIER_END : null;
      await setHealth(account.id, state, { pausedUntil, at: new Date(0) });
      const cause = { at: THURSDAY, trigger: TRIGGERS[signal], metrics: { rate: 0.1 } };
      const change = await account.run(() => applyHealth(tenantClient, account.id, signal, cause));
      const { row, events, outbox } = await written(account);
      if (expected === null || expected === "extend") {
        assert.equal(change, null, label);
        const end = expected === "extend" ? COOLDOWN_END : pausedUntil;
        assert.deepEqual(
          [row.healthState, row.pausedUntil, row.healthChangedAt],
          [state, end, new Date(0)],
          label,
        );
        assert.deepEqual([events.length, outbox.length], [0, 0], label);
        continue;
      }
      const to = expected as HealthState;
      const [event] = events;
      assert.deepEqual(change, { from: state, to, healthEventId: event?.id }, label);
      const end = cooling(to) ? COOLDOWN_END : null;
      assert.deepEqual(
        [row.healthState, row.pausedUntil, row.healthChangedAt],
        [to, end, THURSDAY],
        label,
      );
      assert.deepEqual(
        [events.length, event?.fromState, event?.toState, event?.trigger, event?.automaticAction],
        [1, state, to, TRIGGERS[signal], ACTION[to]],
        label,
      );
      assert.deepEqual(
        [
          event?.ackRequired,
          event?.pausedUntil,
          event?.metrics,
          event?.senderType,
          event?.createdAt,
        ],
        [cooling(to), end, { rate: 0.1 }, "linkedin", THURSDAY],
        label,
      );
      const announced = outbox.map((entry) => entry.payload);
      const payload = { sender_account_id: account.id, health_event_id: event?.id };
      assert.deepEqual(announced, to === "healthy" ? [] : [payload], label);
    }
  }
});

test("a cool-down never moves earlier: a restriction, and a checkpoint over it, keep a later end that stands", async () => {
  const account = await sender();
  const later = new Date(THURSDAY.getTime() + 100 * HOUR_MS);
  await setHealth(account.id, "restricted", { pausedUntil: later });
  const at = { at: THURSDAY, trigger: "limit_reached" } as const;
  assert.equal(
    await account.run(() => applyHealth(tenantClient, account.id, "restricted", at)),
    null,
  );
  const checkpoint = { at: THURSDAY, trigger: "checkpoint" } as const;
  await account.run(() => applyHealth(tenantClient, account.id, "checkpoint", checkpoint));
  const { row, events } = await written(account);
  assert.deepEqual([row.healthState, row.pausedUntil], ["checkpoint", later]);
  assert.deepEqual(
    events.map((event) => event.pausedUntil),
    [later],
  );
});

test("the user's own disconnect changes no health: a healthy account stays healthy, a restricted one keeps its state and cool-down, with no event and no linkedin.account_paused", async () => {
  const cases = [
    ["healthy", null, null, 0, 0],
    ["restricted", THURSDAY, COOLDOWN_END, 1, 1],
  ] as const;
  for (const expected of cases) {
    const account = await sender();
    if (expected[0] === "restricted") {
      const cause = { at: THURSDAY, trigger: "limit_reached" } as const;
      await account.run(() => applyHealth(tenantClient, account.id, "restricted", cause));
    }
    await account.run(() => disconnect(account.id));
    const { row, events, outbox } = await written(account);
    assert.equal(row.status, "disconnected", expected[0]);
    assert.deepEqual(
      [row.healthState, row.healthChangedAt, row.pausedUntil, events.length, outbox.length],
      expected,
    );
  }
});

test("a pause releases the account's open send reservations, its reads and settled ones kept, and frees their slots; a send past its re-read still commits; at_risk releases nothing", async () => {
  const account = await sender();
  const committed = granted(await account.send("committed", "message"));
  await account.commit(committed);
  const invite = granted(await account.send("invite", "invite"));
  const message = granted(await account.send("message", "message"));
  const read = granted(await account.read());
  const status = async () => {
    const rows = await app.senderQuotaReservation.findMany({
      where: { senderAccountId: account.id },
    });
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
  };
  const atRisk = { at: THURSDAY, trigger: "acceptance_rate" } as const;
  await account.run(() => applyHealth(tenantClient, account.id, "at_risk", atRisk));
  assert.deepEqual(Object.values(await status()).sort(), [
    "committed",
    "reserved",
    "reserved",
    "reserved",
  ]);
  const restricted = { at: THURSDAY, trigger: "limit_reached" } as const;
  await account.run(() => applyHealth(tenantClient, account.id, "restricted", restricted));
  assert.deepEqual(await status(), {
    [committed]: "committed",
    [invite]: "released",
    [message]: "released",
    [read]: "reserved",
  });
  const [day] = await account.days();
  const { invitesReserved, messagesReserved, readsReserved, messagesCommitted } = day ?? {};
  assert.deepEqual(
    [invitesReserved, messagesReserved, readsReserved, messagesCommitted],
    [0, 0, 1, 1],
  );
  // The message's activity was past its re-read: its call went out, and it counts.
  assert.equal((await account.commit(message)).status, "committed");
  assert.equal((await account.days())[0]?.messagesCommitted, 2);
});

test("healthSignalOf: linkedin_limit_reached restricted (limit_reached); linkedin_account_disconnected by reason, checkpoint checkpoint, restricted restricted (limit_reached), credentials_required, disconnected, another or none disconnected (session_invalid); any other code none; each state the error map's account column says", () => {
  const { errors } = linkedinPort;
  const cases = [
    [errors.linkedin_limit_reached, undefined, "restricted", "limit_reached"],
    [errors.linkedin_account_disconnected, { reason: "checkpoint" }, "checkpoint", "checkpoint"],
    [errors.linkedin_account_disconnected, { reason: "restricted" }, "restricted", "limit_reached"],
    [
      errors.linkedin_account_disconnected,
      { reason: "credentials_required" },
      "disconnected",
      "session_invalid",
    ],
    [
      errors.linkedin_account_disconnected,
      { reason: "disconnected" },
      "disconnected",
      "session_invalid",
    ],
    [errors.linkedin_account_disconnected, { reason: "other" }, "disconnected", "session_invalid"],
    [errors.linkedin_account_disconnected, undefined, "disconnected", "session_invalid"],
  ] as const;
  for (const [code, details, signal, trigger] of cases) {
    assert.deepEqual(
      healthSignalOf(code, details),
      { signal, trigger },
      `${code} ${details?.reason}`,
    );
    const effect = SEND_ERROR_MAP[sendAnswerOf(code, details?.reason)].account;
    assert.ok(effect !== null && "health" in effect && effect.health === signal, "the map agrees");
  }
  for (const code of Object.values(errors)) {
    if (code === errors.linkedin_limit_reached || code === errors.linkedin_account_disconnected) {
      continue;
    }
    assert.equal(healthSignalOf(code), null, code);
  }
});

test("the next working day's start, Monday to Friday in the account's zone: Thursday's is Friday's midnight, Friday's and Saturday's Monday's; in Kolkata, a Friday evening in UTC is already Saturday", () => {
  const at = (iso: string, zone = "UTC") => nextWorkingDayAt(new Date(iso), zone).toISOString();
  assert.equal(at("2026-10-22T10:00:00Z"), "2026-10-23T00:00:00.000Z");
  assert.equal(at("2026-10-23T23:59:00Z"), "2026-10-26T00:00:00.000Z");
  assert.equal(at("2026-10-24T09:00:00Z"), "2026-10-26T00:00:00.000Z");
  assert.equal(at("2026-10-23T20:00:00Z", "Asia/Kolkata"), "2026-10-25T18:30:00.000Z");
});

test("two third errors at once, each in its own run on its own connection: one moves retry_at with one event, the other finds the account paused until then", async () => {
  const account = await sender();
  const error = { accountId: account.id, kind: "read_profile", count: 1 } as const;
  for (const n of [1, 2]) {
    await account.run(() => logAction({ ...error, outcome: "linkedin_rate_limited" }), app);
    assert.equal(await account.run(() => pauseOnThirdError(account.id, THURSDAY)), null, `${n}`);
  }
  const clients = [0, 1].map(() => createDbClient("app", { schema: db.schema }));
  try {
    const answers = await Promise.all(
      clients.map((client) =>
        account.run(async () => {
          await logAction({ ...error, outcome: "linkedin_provider_error" });
          return pauseOnThirdError(account.id, THURSDAY);
        }, client),
      ),
    );
    const friday = new Date("2026-10-23T00:00:00Z");
    assert.deepEqual(
      answers.filter((answer) => answer !== null),
      [friday],
    );
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
  const { row, events } = await written(account);
  assert.equal(events.length, 1);
  assert.deepEqual(
    [row.healthState, row.retryAt, events[0]?.trigger],
    ["healthy", new Date("2026-10-23T00:00:00Z"), "rate_limit_errors"],
  );
});
