// The read quota (docs/concepts.md "Read quota", docs/flows.md): reserve, read, then commit or release,
// each in the caller's own tenant run (an activity's context.tenant), on its transaction, as credits'
// reserve does. reserveReads takes the day's usage row (INSERT … ON CONFLICT DO NOTHING, then SELECT …
// FOR UPDATE), so an account's reservations queue on it; commit and release take that row too. The
// quota day and the window come from the account's time zone and working hours. A refusal is an
// answer, not a throw, so the caller's run commits the action-log row that records it.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { linkedinConfig } from "../../config.ts";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { commitInput, type ReserveInput, releaseInput, reserveInput } from "../../schemas/quota.ts";
import { findAccount } from "../accounts.ts";
import { writeLog } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { parseInput } from "../input.ts";
import { isWindowOpen, nextQuotaDayAt, nextWindowAt, quotaDay } from "./window.ts";

/** A reservation holds its reads this long; the next reservation of its day frees it after. */
export const RESERVATION_MS = 60 * 60_000;

export type Reservation = { readonly reservationId: string; readonly granted: number };
export type Refusal = {
  readonly refused: "read_cap_reached" | "outside_working_hours" | "linkedin_account_disconnected";
  /** When to ask again: the next quota day's start, or the next window's; null when not connected. */
  readonly retryAt: Date | null;
};
export type Usage = {
  readonly quotaDay: string;
  readonly cap: number;
  readonly capMax: number;
  readonly reserved: number;
  readonly committed: number;
  readonly windowOpen: boolean;
  readonly nextWindowAt: Date;
};
type Day = { readonly id: string; readonly readsReserved: number; readonly readsCommitted: number };
type Held = {
  readonly id: string;
  readonly usageId: string;
  readonly count: number;
  readonly committed: number | null;
  readonly status: string;
};

/**
 * `count` reads for the account, all or none: refused while it is not connected, outside its working
 * hours, or when the day's reads reserved and made would pass its cap. One action-log row either way.
 * The cap is the account's row as this reservation reads it, so a cap changed since the last one
 * holds from here, on the same quota day.
 */
export async function reserveReads(input: ReserveInput): Promise<Reservation | Refusal> {
  const { accountId, count, kind, objectRef } = parseInput(reserveInput, input);
  const account = await findAccount(accountId);
  const { timeZone, workingHours, dailyReadCap } = account;
  const at = now();
  const log = (outcome: string) => writeLog(account.id, { kind, objectRef, count, outcome }, at);
  const refuse = async (refused: Refusal["refused"], retryAt: Date | null): Promise<Refusal> => {
    await log(refused);
    return { refused, retryAt };
  };
  if (account.status !== "connected") return refuse("linkedin_account_disconnected", null);
  if (!isWindowOpen(at, timeZone, workingHours)) {
    return refuse("outside_working_hours", nextWindowAt(at, timeZone, workingHours));
  }
  const day = await lockDay(account.id, quotaDay(at, timeZone));
  const reserved = day.readsReserved - (await sweep(day.id, at));
  if (reserved + day.readsCommitted + count > dailyReadCap) {
    if (reserved !== day.readsReserved) await setReserved(day.id, reserved);
    return refuse("read_cap_reached", nextQuotaDayAt(at, timeZone));
  }
  const reservationId = newId(ids.sender_quota_reservation);
  const expiresAt = new Date(at.getTime() + RESERVATION_MS);
  await tenantClient.senderQuotaReservation.create({
    data: {
      id: reservationId,
      workspaceId: currentTenant().workspaceId,
      senderAccountId: account.id,
      usageId: day.id,
      count,
      expiresAt,
      createdAt: at,
    },
  });
  await setReserved(day.id, reserved + count);
  await log("reserved");
  return { reservationId, granted: count };
}

/** The reads made; a repeat answers as the first. After the hour it still counts them: they happened. */
export async function commitReads(
  reservationId: string,
  actual: number,
): Promise<{ reservationId: string; committed: number }> {
  const valid = parseInput(commitInput, { reservationId, actual });
  const held = await lockReservation(valid.reservationId);
  if (held.status === "committed")
    return { reservationId: held.id, committed: held.committed ?? 0 };
  if (held.status === "released") throw notOpen(held.id);
  await settle(held, "committed", valid.actual);
  return { reservationId: held.id, committed: valid.actual };
}

/** Frees the reads; a repeat, or a reservation the sweep freed, changes nothing. */
export async function releaseReads(reservationId: string): Promise<void> {
  const valid = parseInput(releaseInput, { reservationId });
  const held = await lockReservation(valid.reservationId);
  if (held.status === "committed") throw notOpen(held.id);
  if (held.status === "reserved") await settle(held, "released", 0);
}

/** The account's reads today over its cap and its window now, in its time zone. */
export async function readUsage(accountId: string): Promise<Usage> {
  const account = await findAccount(accountId);
  const { timeZone, workingHours } = account;
  const at = now();
  const date = quotaDay(at, timeZone);
  const row = await tenantClient.senderQuotaUsage.findFirst({
    where: { senderAccountId: account.id, quotaDay: date },
  });
  return {
    quotaDay: date,
    cap: account.dailyReadCap,
    capMax: linkedinConfig.LINKEDIN_DAILY_READ_CAP_MAX,
    reserved: row?.readsReserved ?? 0,
    committed: row?.readsCommitted ?? 0,
    windowOpen: isWindowOpen(at, timeZone, workingHours),
    nextWindowAt: nextWindowAt(at, timeZone, workingHours),
  };
}

/** The day's usage row, made when missing, locked to the run's end. */
async function lockDay(senderAccountId: string, date: string): Promise<Day> {
  const { workspaceId } = currentTenant();
  const id = newId(ids.sender_quota_usage);
  await tenantClient.senderQuotaUsage.createMany({
    data: [{ id, workspaceId, senderAccountId, quotaDay: date }],
    skipDuplicates: true,
  });
  const [day] = await tenantClient.$queryRaw<Day[]>`
    SELECT id, reads_reserved AS "readsReserved", reads_committed AS "readsCommitted"
    FROM sender_quota_usage
    WHERE workspace_id = ${workspaceId} AND sender_account_id = ${senderAccountId}
      AND quota_day = ${date}
    FOR UPDATE`;
  if (day === undefined) throw new Error("no usage row after its insert");
  return day;
}

/** The lazy sweep: the day's reservations past their hour expire; the reads they held. */
async function sweep(usageId: string, at: Date): Promise<number> {
  const expired = await tenantClient.$queryRaw<{ count: number }[]>`
    UPDATE sender_quota_reservations SET status = 'expired', settled_at = ${at}::timestamptz
    WHERE workspace_id = ${currentTenant().workspaceId} AND usage_id = ${usageId}
      AND status = 'reserved' AND expires_at <= ${at}::timestamptz
    RETURNING count`;
  return expired.reduce((sum, { count }) => sum + count, 0);
}

function setReserved(usageId: string, readsReserved: number) {
  return tenantClient.senderQuotaUsage.update({ where: { id: usageId }, data: { readsReserved } });
}

/** The reservation, read again once its day's row is locked: a day's settlements queue there too. */
async function lockReservation(id: string): Promise<Held> {
  const found = await tenantClient.senderQuotaReservation.findFirst({
    where: { id },
    select: { usageId: true },
  });
  if (found === null) throw notOpen(id);
  await tenantClient.$queryRaw`
    SELECT id FROM sender_quota_usage
    WHERE id = ${found.usageId} AND workspace_id = ${currentTenant().workspaceId}
    FOR UPDATE`;
  return tenantClient.senderQuotaReservation.findFirstOrThrow({
    where: { id },
    select: { id: true, usageId: true, count: true, committed: true, status: true },
  });
}

/** The new status; on the day, the reads no longer held and the reads made. */
async function settle(held: Held, status: "committed" | "released", made: number): Promise<void> {
  const committed = status === "committed" ? made : null;
  await tenantClient.senderQuotaReservation.update({
    where: { id: held.id },
    data: { status, committed, settledAt: now() },
  });
  const freed = held.status === "reserved" ? held.count : 0;
  await tenantClient.senderQuotaUsage.update({
    where: { id: held.usageId },
    data: { readsReserved: { decrement: freed }, readsCommitted: { increment: made } },
  });
}

const notOpen = (reservationId: string) =>
  new AppError(errors.reservation_not_open, { details: { reservation_id: reservationId } });
