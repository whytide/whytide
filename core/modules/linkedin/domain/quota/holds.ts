// A day's reservations, reads and sends alike (docs/flows.md "Reservations"): the lazy sweep of
// those past their hold, a reservation locked through its day's row, and its settle. Each moves the
// counters of the reservation's own action type on the day's row, by increments in the statement,
// never set to a count read before. The raw statements name the run's workspace themselves, as the
// scoped client does for the rest.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { now } from "../clock.ts";
import type { Day } from "./days.ts";
import type { DayUsage } from "./limits.ts";

export type ActionType = "read" | "invite" | "message" | "withdraw";
export type HoldStatus = "reserved" | "committed" | "released" | "expired" | "committed_late";
/** A reservation as its day's lock holds it. */
export type Held = {
  readonly id: string;
  readonly senderAccountId: string;
  readonly usageId: string;
  readonly actionType: ActionType;
  readonly idempotencyKey: string | null;
  readonly count: number;
  readonly committed: number | null;
  readonly status: HoldStatus;
  readonly expiresAt: Date;
};
type Counter = keyof DayUsage;

/** Each action type's counters on the day's row: what its open reservations hold, what was made. */
const COUNTERS: Readonly<Record<ActionType, { reserved: Counter; committed: Counter }>> = {
  read: { reserved: "readsReserved", committed: "readsCommitted" },
  invite: { reserved: "invitesReserved", committed: "invitesCommitted" },
  message: { reserved: "messagesReserved", committed: "messagesCommitted" },
  withdraw: { reserved: "withdrawalsReserved", committed: "withdrawalsCommitted" },
};
const HELD = {
  id: true,
  senderAccountId: true,
  usageId: true,
  actionType: true,
  idempotencyKey: true,
  count: true,
  committed: true,
  status: true,
  expiresAt: true,
} as const;

/** The type's counters on the day's row, moved by the deltas in the statement itself. */
export async function moveCounters(
  usageId: string,
  type: ActionType,
  reserved: number,
  committed = 0,
): Promise<void> {
  const counters = COUNTERS[type];
  await tenantClient.senderQuotaUsage.update({
    where: { id: usageId },
    data: {
      [counters.reserved]: { increment: reserved },
      [counters.committed]: { increment: committed },
    },
  });
}

/**
 * The lazy sweep: the day's reservations of every type past their hold expire, and what they held
 * comes off their type's counter. Answers the day as the run now has it.
 */
export async function sweep(day: Day, at: Date): Promise<Day> {
  const expired = await tenantClient.$queryRaw<{ action_type: ActionType; count: number }[]>`
    UPDATE sender_quota_reservations SET status = 'expired', settled_at = ${at}::timestamptz
    WHERE workspace_id = ${currentTenant().workspaceId} AND usage_id = ${day.id}
      AND status = 'reserved' AND expires_at <= ${at}::timestamptz
    RETURNING action_type::text AS action_type, count`;
  const freed = new Map<ActionType, number>();
  for (const { action_type, count } of expired) {
    freed.set(action_type, (freed.get(action_type) ?? 0) + count);
  }
  let swept = day;
  for (const [type, count] of freed) {
    await moveCounters(day.id, type, -count);
    const counter = COUNTERS[type].reserved;
    swept = { ...swept, [counter]: swept[counter] - count };
  }
  return swept;
}

/**
 * The account's row locked to the run's end, in the run's workspace only, before any of its days'
 * rows: the order every run that touches both keeps (health/apply.ts). An invite's commit, which
 * adds to the account's pending count, and the pending invitations' check, which writes it, take it.
 */
export async function lockAccountRow(accountId: string): Promise<void> {
  await tenantClient.$queryRaw`
    SELECT id FROM sender_accounts
    WHERE id = ${accountId} AND workspace_id = ${currentTenant().workspaceId}
    FOR UPDATE`;
}

/** The day's row locked to the run's end, in the run's workspace only; whether it was found. */
export async function lockUsage(usageId: string): Promise<boolean> {
  const locked = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM sender_quota_usage
    WHERE id = ${usageId} AND workspace_id = ${currentTenant().workspaceId}
    FOR UPDATE`;
  return locked.length > 0;
}

/** The reservation, read again once its day's row is locked: a day's settlements queue there too. */
export async function lockReservation(id: string): Promise<Held> {
  const found = await tenantClient.senderQuotaReservation.findFirst({
    where: { id },
    select: { usageId: true },
  });
  if (found === null || !(await lockUsage(found.usageId))) throw notOpen(id);
  return tenantClient.senderQuotaReservation.findFirstOrThrow({ where: { id }, select: HELD });
}

/** The new status; on the day, what the reservation held no longer held, and the actions made. */
export async function settle(
  held: Held,
  status: Exclude<HoldStatus, "reserved">,
  made: number,
): Promise<void> {
  const counts = status === "committed" || status === "committed_late";
  await tenantClient.senderQuotaReservation.update({
    where: { id: held.id },
    data: { status, committed: counts ? made : null, settledAt: now() },
  });
  const freed = held.status === "reserved" ? held.count : 0;
  await moveCounters(held.usageId, held.actionType, -freed, made);
}

export const notOpen = (reservationId: string) =>
  new AppError(errors.reservation_not_open, { details: { reservation_id: reservationId } });
