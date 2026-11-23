// A send's slot (docs/flows.md "Sends"): reserveSend takes one connection request, message or
// withdrawal from the account's budgets before the port call, under the step's idempotency key
// (campaigns' to build, never built here), in the caller's tenant run with the day's row locked, as
// reserveReads does. A refusal is an answer whose action-log row the caller's run commits. A repeat
// of a key answers the reservation that holds it and takes no second slot; a released or expired
// key reserves again, as a new row. commitSend and releaseSend (settle.ts) settle the slot.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import {
  type ActionOutcome,
  type SendActionType,
  type SendInput,
  sendInput,
} from "../../schemas/quota.ts";
import { noteSettings } from "../../settings.ts";
import { findAccount, type SenderAccount } from "../accounts.ts";
import { writeLog } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { parseInput } from "../input.ts";
import { DAY_MS } from "../quota/constants.ts";
import { type Day, dayOf, invitesByDay } from "../quota/days.ts";
import { lockReservation, moveCounters, settle, sweep } from "../quota/holds.ts";
import {
  actionsLeft,
  dayEndsAt,
  dayStartsAt,
  quotaDayBefore,
  sendsLeft,
  weekLeft,
  weekOpensIn,
} from "../quota/limits.ts";
import { INVITE_NOTE_WINDOW_DAYS, SEND_RESERVATION_MS } from "./constants.ts";
import { type StateRefusal, sendStateRefusal } from "./state.ts";

export type SendReservation = {
  readonly reservationId: string;
  /** `reserved`: the slot is held for the call; `committed`: a repeat whose send went out already. */
  readonly status: "reserved" | "committed";
};
export type SendRefusal = {
  readonly refused:
    | StateRefusal["refused"]
    | "invite_note_budget"
    | "invite_cap_reached"
    | "message_cap_reached"
    | "withdrawal_cap_reached"
    | "weekly_invite_cap_reached"
    | "daily_actions_cap_reached";
  /** When to ask again; null when only a switch, a reconnection or other working hours can open it. */
  readonly retryAt: Date | null;
};

const CAP_REACHED = {
  invite: "invite_cap_reached",
  message: "message_cap_reached",
  withdraw: "withdrawal_cap_reached",
} as const satisfies Record<SendActionType, SendRefusal["refused"]>;
const NOTE_WINDOW_MS = INVITE_NOTE_WINDOW_DAYS * DAY_MS;

/**
 * One send's slot for the account under the step's key, or a refusal, in this order: the account's
 * state (send/state.ts: sending closed, a kill switch, not connected, invites paused, retry_at ahead,
 * outside its weekday window), the month's notes for an invite with one, the day's limit of the
 * type, the week's 100 for an invite, and the day's 200. One action-log row either way; a repeat of
 * a key writes none and answers its hold, a switch or not: the send activity asks sendStateRefusal
 * again before the port call (beta-p1-050).
 */
export async function reserveSend(input: SendInput): Promise<SendReservation | SendRefusal> {
  const { accountId, actionType, idempotencyKey, withNote = false } = parseInput(sendInput, input);
  const account = await findAccount(accountId);
  const at = now();
  const repeat = await holderOf(idempotencyKey, at);
  if (repeat !== null) return repeat;
  const log = (outcome: ActionOutcome) =>
    writeLog(account.id, { kind: actionType, count: 1, outcome, withNote }, at);
  const refuse = async ({ refused, retryAt }: SendRefusal): Promise<SendRefusal> => {
    await log(refused);
    return { refused, retryAt };
  };
  const state = await sendStateRefusal(account, actionType, at);
  if (state !== null) return refuse(state);
  await expireStale(idempotencyKey, at);
  const locked = await dayOf(account, at, true);
  // The key again under the day's lock: a twin of this call may have reserved it meanwhile.
  const twin = await holderOf(idempotencyKey, at);
  if (twin !== null) return twin;
  const day = await sweep(locked, at);
  const budget = await budgetRefusal(account, day, actionType, withNote, at);
  if (budget !== null) return refuse(budget);
  const reservationId = newId(ids.sender_quota_reservation);
  const made = await tenantClient.senderQuotaReservation.createMany({
    data: [
      {
        id: reservationId,
        workspaceId: currentTenant().workspaceId,
        senderAccountId: account.id,
        usageId: day.id,
        actionType,
        idempotencyKey,
        withNote,
        count: 1,
        // Exactly SEND_RESERVATION_MS after created_at: a pause infers from a later expiry that the
        // slot is kept for its check (health/apply.ts keptForCheck), so keep the two in step.
        expiresAt: new Date(at.getTime() + SEND_RESERVATION_MS),
        createdAt: at,
      },
    ],
    // The partial unique index: another account's day may have taken the key meanwhile.
    skipDuplicates: true,
  });
  if (made.count === 0) {
    const holder = await holderOf(idempotencyKey, at);
    if (holder === null) throw new Error("a send key held by no reservation");
    return holder;
  }
  await moveCounters(day.id, actionType, 1);
  await log("reserved");
  return { reservationId, status: "reserved" };
}

/**
 * The answer to a repeat of the key: the reservation holding it, reserved within its hold or
 * committed; else a late commit's, as committed, since its send went out; null when the key is free.
 */
async function holderOf(idempotencyKey: string, at: Date): Promise<SendReservation | null> {
  const rows = await tenantClient.senderQuotaReservation.findMany({
    where: { idempotencyKey, status: { in: ["reserved", "committed", "committed_late"] } },
    select: { id: true, status: true, expiresAt: true },
  });
  const live = rows.find(
    (row) => row.status === "committed" || (row.status === "reserved" && row.expiresAt > at),
  );
  if (live !== undefined) {
    return {
      reservationId: live.id,
      status: live.status === "reserved" ? "reserved" : "committed",
    };
  }
  const late = rows.find((row) => row.status === "committed_late");
  return late === undefined ? null : { reservationId: late.id, status: "committed" };
}

/**
 * The key's reservations past their hold that no sweep has reached yet, expired on their own day's
 * row, locked first, so that the key is free for the new row.
 */
async function expireStale(idempotencyKey: string, at: Date): Promise<void> {
  const stale = await tenantClient.senderQuotaReservation.findMany({
    where: { idempotencyKey, status: "reserved", expiresAt: { lte: at } },
    select: { id: true },
  });
  for (const { id } of stale) {
    const held = await lockReservation(id);
    if (held.status === "reserved" && held.expiresAt <= at) await settle(held, "expired", 0);
  }
}

async function budgetRefusal(
  account: SenderAccount,
  day: Day,
  type: SendActionType,
  withNote: boolean,
  at: Date,
): Promise<SendRefusal | null> {
  if (withNote) {
    // With the budget counted (LINKEDIN_INVITE_NOTES_PER_MONTH, 3 unset), its oldest note, the
    // budget's newest back, must leave the 30 days first.
    const budget = noteSettings.LINKEDIN_INVITE_NOTES_PER_MONTH;
    const oldest = (await notesCounted(account.id, at)).at(-budget);
    if (oldest !== undefined) {
      return { refused: "invite_note_budget", retryAt: new Date(oldest + NOTE_WINDOW_MS) };
    }
  }
  const nextDay = dayEndsAt(day, account.timeZone);
  if (sendsLeft(day, type) < 1) return { refused: CAP_REACHED[type], retryAt: nextDay };
  if (type === "invite") {
    const byDay = await invitesByDay(account.id, day.quotaDay);
    let before = 0;
    for (const count of byDay.values()) before += count;
    if (weekLeft(day, before) < 1) {
      byDay.set(day.quotaDay, day.invitesReserved + day.invitesCommitted);
      const opens = quotaDayBefore(day.quotaDay, -weekOpensIn(day.quotaDay, byDay));
      const retryAt = dayStartsAt(opens, day, account.timeZone);
      return { refused: "weekly_invite_cap_reached", retryAt };
    }
  }
  if (actionsLeft(day) < 1) return { refused: "daily_actions_cap_reached", retryAt: nextDay };
  return null;
}

/**
 * The account's invitation notes the month counts, as times oldest first: those sent in the last
 * INVITE_NOTE_WINDOW_DAYS (`ok` invite rows with a note) and those reserved and still held, so two
 * reservations made close together cannot both pass.
 */
async function notesCounted(senderAccountId: string, at: Date): Promise<number[]> {
  const since = new Date(at.getTime() - NOTE_WINDOW_MS);
  const sent = await tenantClient.senderActionLog.findMany({
    where: { senderAccountId, kind: "invite", outcome: "ok", withNote: true, at: { gt: since } },
    select: { at: true },
  });
  const held = await tenantClient.senderQuotaReservation.findMany({
    where: {
      senderAccountId,
      actionType: "invite",
      withNote: true,
      status: "reserved",
      expiresAt: { gt: at },
    },
    select: { createdAt: true },
  });
  const times = [...sent.map((row) => row.at), ...held.map((row) => row.createdAt)];
  return times.map((time) => time.getTime()).sort((a, b) => a - b);
}
