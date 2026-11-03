// The account's health (README.md "Health", docs/flows.md "Health"): applyHealth is the one function
// that changes it, in the transaction of its cause (the webhook's run, the status write, the run that
// logs a port error), the account's row locked first (SELECT … FOR UPDATE), so a warning is never
// recorded without its pause, and its outbox event leaves with the same commit. A change writes the
// state, one health event and the metric; into restricted, checkpoint, disconnected or at_risk it
// publishes linkedin.account_paused, the owner's mail (mail.ts); into restricted or checkpoint it
// trips the fleet breaker (breaker.ts); into the first three it releases the account's open send
// reservations, but a slot kept for a send whose outcome is unknown. A cool-down never moves
// earlier, and a disconnect or a reconnect never ends it (C26): only the owner's resume does
// (beta-p6-040). The lock comes before the day's row a release locks, the order every run that
// touches both keeps.
import { outboxWriter, type TenantClient } from "@whytide/db";
import { currentTenant, newId, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { linkedinMetrics } from "../../metrics.ts";
import { lockReservation, settle } from "../quota/holds.ts";
import { SEND_RESERVATION_MS } from "../send/constants.ts";
import { tripBreaker } from "./breaker.ts";
import { COOLDOWN_MS } from "./constants.ts";
import {
  ACTIONS,
  BREAKER_STATES,
  COOLDOWN_STATES,
  type HealthAction,
  type HealthSignal,
  type HealthState,
  type HealthTrigger,
  isPaused,
  transitionOf,
} from "./states.ts";

/** A health event's numbers and codes: never a person's data, a reference or a provider's message. */
export type HealthMetrics = Readonly<Record<string, number | string>>;
export type HealthCause = {
  readonly at: Date;
  readonly trigger: HealthTrigger;
  readonly metrics?: HealthMetrics;
  /** The user whose own act this is, which the event records as acknowledged by them: the resume's. */
  readonly acknowledgedBy?: string;
};
/** A change applyHealth made, and its event. */
export type HealthChange = {
  readonly from: HealthState;
  readonly to: HealthState;
  readonly healthEventId: string;
};
/** The account's row as the lock read it. */
export type LockedAccount = {
  readonly healthState: HealthState;
  readonly pausedUntil: Date | null;
  readonly retryAt: Date | null;
  readonly timeZone: string;
};
/** One health event as recorded. */
export type HealthEntry = {
  readonly from: HealthState;
  readonly to: HealthState;
  readonly trigger: HealthTrigger;
  readonly metrics: HealthMetrics;
  readonly action: HealthAction;
  /** The end of the pause the event set, null when it set none. */
  readonly pausedUntil: Date | null;
  readonly ackRequired: boolean;
  readonly at: Date;
  /** linkedin.account_paused published with it: the owner's mail. */
  readonly announce: boolean;
  /** Acknowledged by this user at `at`, as it is written. */
  readonly acknowledgedBy?: string | undefined;
};

/**
 * The signal applied to the account at `cause.at`, in the caller's run, whose transaction `tx` is:
 * the change, or null when nothing changed (no such account in the run's workspace, a signal its
 * state ignores, or a cool-down moved on). A cool-down ends COOLDOWN_MS after `at`, or later when
 * one stands already.
 */
export async function applyHealth(
  tx: TenantClient,
  accountId: string,
  signal: HealthSignal,
  cause: HealthCause,
): Promise<HealthChange | null> {
  const account = await lockAccount(tx, accountId);
  if (account === null) return null;
  const from = account.healthState;
  const to = transitionOf(from, signal);
  if (to === null) return null;
  const cooldown = latest(account.pausedUntil, new Date(cause.at.getTime() + COOLDOWN_MS));
  if (to === "extend") {
    if (cooldown.getTime() !== account.pausedUntil?.getTime()) {
      await tx.senderAccount.update({ where: { id: accountId }, data: { pausedUntil: cooldown } });
    }
    return null;
  }
  const pausedUntil = COOLDOWN_STATES.includes(to) ? cooldown : null;
  await tx.senderAccount.update({
    where: { id: accountId },
    data: { healthState: to, healthChangedAt: cause.at, pausedUntil },
  });
  const healthEventId = await recordHealthEvent(tx, accountId, {
    from,
    to,
    trigger: cause.trigger,
    metrics: cause.metrics ?? {},
    action: ACTIONS[to],
    pausedUntil,
    ackRequired: COOLDOWN_STATES.includes(to),
    at: cause.at,
    announce: to !== "healthy",
    acknowledgedBy: cause.acknowledgedBy,
  });
  linkedinMetrics["linkedin.health_changes"].add(1, { status: to, trigger: cause.trigger });
  if (BREAKER_STATES.includes(to)) {
    await tripBreaker(tx, accountId, { id: healthEventId, trigger: cause.trigger });
  }
  if (isPaused(to)) await releaseOpenSends(tx, accountId);
  return { from, to, healthEventId };
}

/** One health event in the run, with linkedin.account_paused when it announces: its id. */
export async function recordHealthEvent(
  tx: TenantClient,
  accountId: string,
  entry: HealthEntry,
): Promise<string> {
  const id = newId(ids.sender_health_event);
  const { workspaceId } = currentTenant();
  await tx.senderHealthEvent.create({
    data: {
      id,
      workspaceId,
      senderId: accountId,
      fromState: entry.from,
      toState: entry.to,
      trigger: entry.trigger,
      metrics: entry.metrics,
      automaticAction: entry.action,
      pausedUntil: entry.pausedUntil,
      ackRequired: entry.ackRequired,
      ...(entry.acknowledgedBy === undefined
        ? {}
        : { acknowledgedBy: entry.acknowledgedBy, acknowledgedAt: entry.at }),
      createdAt: entry.at,
    },
  });
  if (entry.announce) {
    const paused = events["linkedin.account_paused"];
    const payload = { sender_account_id: accountId, health_event_id: id };
    await publish(outboxWriter(tx, workspaceId), paused, payload);
  }
  return id;
}

/** The account's row locked to the run's end, in the run's workspace only; null when not found. */
export async function lockAccount(
  tx: TenantClient,
  accountId: string,
): Promise<LockedAccount | null> {
  const [row] = await tx.$queryRaw<LockedAccount[]>`
    SELECT health_state::text AS "healthState", paused_until AS "pausedUntil",
      retry_at AS "retryAt", time_zone AS "timeZone"
    FROM sender_accounts
    WHERE workspace_id = ${currentTenant().workspaceId} AND id = ${accountId}
    FOR UPDATE`;
  return row ?? null;
}

/** The later of two instants, the second when the first is null. */
const latest = (standing: Date | null, next: Date): Date =>
  standing !== null && standing > next ? standing : next;

/**
 * Each open send reservation of the account released, its slot free again today; reads stay. A slot
 * kept past its own hold, for a send whose outcome is unknown (holdSendUntil), stays held for the
 * check after the pause: freed, a reconnect the same day could take it again before that send's late
 * commit counts, one over the day's limit. One settled since the list was read, under its day's lock,
 * is left as it is.
 */
async function releaseOpenSends(tx: TenantClient, accountId: string): Promise<void> {
  const open = await tx.senderQuotaReservation.findMany({
    where: { senderAccountId: accountId, status: "reserved", actionType: { not: "read" } },
    select: { id: true, createdAt: true },
    orderBy: { id: "asc" },
  });
  for (const { id, createdAt } of open) {
    const held = await lockReservation(id);
    if (held.status !== "reserved" || keptForCheck(held.expiresAt, createdAt)) continue;
    await settle(held, "released", 0);
  }
}

/** A send's slot held past its own hold: only holdSendUntil moves one, while its outcome is unknown. */
const keptForCheck = (expiresAt: Date, createdAt: Date): boolean =>
  expiresAt.getTime() > createdAt.getTime() + SEND_RESERVATION_MS;
