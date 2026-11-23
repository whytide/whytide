// The read quota and the day's budgets (docs/concepts.md "Budgets", docs/flows.md): reserve, read,
// then commit or release, each in the caller's own tenant run (an activity's context.tenant), on its
// transaction, as credits' reserve does. reserveReads takes the day's usage row, made with its limits
// drawn once when missing and locked (days.ts), so an account's reservations, reads and sends
// (domain/send/), queue on it; commit and release take that row too (holds.ts). The quota day and
// the window come from the account's time zone and working hours, through platform's time helpers.
// A refusal is an answer, not a throw, so the caller's run commits the action-log row that records it.
// readsLeftToday reads what is left of the day's reads, for signals, and reserves nothing. A company
// page's read (`read_company`) also stays within its share of the day's reads (domain/company/).
import { tenantClient } from "@whytide/db";
import { currentTenant, isWindowOpen, newId, nextWindowAt } from "@whytide/platform";
import { linkedinConfig } from "../../config.ts";
import { ids } from "../../ids.ts";
import {
  type ActionOutcome,
  commitInput,
  type ReserveInput,
  releaseInput,
  reserveInput,
} from "../../schemas/quota.ts";
import { findAccount } from "../accounts.ts";
import { writeLog } from "../action-log/log.ts";
import { now } from "../clock.ts";
import { companyReadsLeft } from "../company/share.ts";
import { readControls, stopOf } from "../controls/controls.ts";
import { sendingDisclosureRequired } from "../disclosure/disclosure.ts";
import { isPaused } from "../health/states.ts";
import { parseInput } from "../input.ts";
import { heldRefusal } from "../invites/held.ts";
import { isWeekend, type ReadStateRefusal, readStateRefusal, sendHours } from "../send/state.ts";
import {
  ACTIONS_PER_DAY_MAX,
  INVITES_PER_WEEK,
  RESERVATION_MS,
  WITHDRAWALS_PER_DAY_MAX,
} from "./constants.ts";
import { dayOf, invitesBefore } from "./days.ts";
import { lockReservation, moveCounters, notOpen, settle, sweep } from "./holds.ts";
import {
  actionsLeft,
  actionsUsed,
  dayEndsAt,
  limitsFor,
  readsGrantable,
  readsLeft,
  windowLeft,
} from "./limits.ts";

export type Reservation = { readonly reservationId: string; readonly granted: number };
export type Refusal = {
  readonly refused: ReadStateRefusal["refused"] | "read_cap_reached" | "daily_actions_cap_reached";
  /** When to ask again: retry_at, the next window's start or the next quota day's; null for a switch or no connection. */
  readonly retryAt: Date | null;
};
type Used = { readonly used: number };
export type Usage = {
  readonly quotaDay: string;
  readonly cap: number;
  readonly capMax: number;
  readonly reserved: number;
  readonly committed: number;
  readonly windowOpen: boolean;
  readonly nextWindowAt: Date;
  readonly readAllowance: number;
  readonly invites: Used & { readonly limit: number };
  readonly messages: Used & { readonly limit: number };
  readonly withdrawals: Used & { readonly max: number };
  readonly weekInvites: Used & { readonly cap: number };
  readonly actions: Used & { readonly max: number };
};
/**
 * What signals may still read today (readsLeftToday): the quota day in use, the reads left, and the
 * account's window now and its next start.
 */
export type ReadsLeft = {
  readonly quotaDay: string;
  readonly left: number;
  readonly windowOpen: boolean;
  readonly nextWindowAt: Date;
};
/** What a campaign may still send today, and when today's window ends (null: none is left, or no send may go). */
export type RemainingToday = {
  readonly invites: number;
  readonly messages: number;
  readonly withdrawals: number;
  /** The actions left of the 200: it bounds each of the three, and their sum (beta-p4-010). */
  readonly actions: number;
  readonly windowEnd: Date | null;
};
/**
 * `count` reads for the account, all or none: refused while a kill switch is on (the platform's, the
 * workspace's or the account's, docs/concepts.md "Kill switches"), while it is not connected, while
 * its retry_at lies ahead, outside its working hours, when the day's reads reserved and made would
 * pass the smaller of the day's read allowance and the account's cap, or when the day's actions
 * would pass the 200, or for `read_company` its share (LINKEDIN_COMPANY_READS_PER_DAY, read_cap_reached
 * with the next quota day's start); with `keep`, when it would leave fewer reads than that in the quota day
 * (read_cap_reached, the next window's start), checked under the day's lock as the cap is, so two
 * reservations at once cannot both pass.
 * One action-log row either way. The cap is the account's row as this reservation reads it, so a
 * lowered cap holds from here; the allowance was drawn with the day's row, so a raised one holds from
 * the next quota day.
 */
export async function reserveReads(input: ReserveInput): Promise<Reservation | Refusal> {
  const { accountId, count, kind, objectRef, keep } = parseInput(reserveInput, input);
  const account = await findAccount(accountId);
  const at = now();
  const log = (outcome: ActionOutcome) =>
    writeLog(account.id, { kind, objectRef, count, outcome }, at);
  const refuse = async ({ refused, retryAt }: Refusal): Promise<Refusal> => {
    await log(refused);
    return { refused, retryAt };
  };
  const state = await readStateRefusal(account, at);
  if (state !== null) return refuse(state);
  const day = await sweep(await dayOf(account, at, true), at);
  const refused =
    count > readsLeft(account, day)
      ? "read_cap_reached"
      : count > actionsLeft(day)
        ? "daily_actions_cap_reached"
        : undefined;
  // A company page's reads stop at their share of the day's reads (LINKEDIN_COMPANY_READS_PER_DAY).
  const share = kind === "read_company" && count > (await companyReadsLeft(account.id, day));
  const over = refused ?? (share ? "read_cap_reached" : undefined);
  if (over !== undefined)
    return refuse({ refused: over, retryAt: dayEndsAt(day, account.timeZone) });
  // The reads kept for the send path's checks: they come back with the next quota day, whose first
  // read waits for the window, open now, to open again.
  if (keep !== undefined && readsGrantable(account, day) - count < keep) {
    const retryAt = nextWindowAt(at, account.timeZone, account.workingHours);
    return refuse({ refused: "read_cap_reached", retryAt });
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
  await moveCounters(day.id, "read", count);
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
  if (held.actionType !== "read") throw notOpen(held.id);
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
  if (held.actionType !== "read" || held.status === "committed") throw notOpen(held.id);
  if (held.status === "reserved") await settle(held, "released", 0);
}

/**
 * The account's quota day (days.ts): its reads over the cap, its budgets with what is used of each
 * (reserved and made), the week's connection requests and the 200, and its window now. It makes
 * today's row when missing, so the screen shows the limits the reservations check.
 */
export async function readUsage(accountId: string): Promise<Usage> {
  const account = await findAccount(accountId);
  const { timeZone, workingHours } = account;
  const at = now();
  const day = await dayOf(account, at, false);
  const invitesToday = day.invitesReserved + day.invitesCommitted;
  const weekInvites = (await invitesBefore(account.id, day.quotaDay)) + invitesToday;
  return {
    quotaDay: day.quotaDay,
    cap: account.dailyReadCap,
    capMax: linkedinConfig.LINKEDIN_DAILY_READ_CAP_MAX,
    reserved: day.readsReserved,
    committed: day.readsCommitted,
    windowOpen: isWindowOpen(at, timeZone, workingHours),
    nextWindowAt: nextWindowAt(at, timeZone, workingHours),
    readAllowance: day.readAllowance,
    invites: { used: invitesToday, limit: day.inviteLimit },
    messages: { used: day.messagesReserved + day.messagesCommitted, limit: day.messageLimit },
    withdrawals: {
      used: day.withdrawalsReserved + day.withdrawalsCommitted,
      max: WITHDRAWALS_PER_DAY_MAX,
    },
    weekInvites: { used: weekInvites, cap: INVITES_PER_WEEK.cap },
    actions: { used: actionsUsed(day), max: ACTIONS_PER_DAY_MAX },
  };
}

/**
 * What the account may still read today, for signals' scheduler (gamma-p5-015): the reads
 * reserveReads would still grant in its quota day, the read budget less what is reserved and made
 * within the 200, as the usage route counts them (a hold past its hour counts until the next
 * reservation sweeps it); 0 while a refusal other than the window's holds, a kill switch, an account
 * not connected, its health's pause or its retry_at; and its window now and its next start. It
 * reserves nothing, and makes today's row when missing, as readUsage does.
 */
export async function readsLeftToday(accountId: string): Promise<ReadsLeft> {
  const account = await findAccount(accountId);
  const { timeZone, workingHours } = account;
  const at = now();
  const state = await readStateRefusal(account, at);
  const day = await dayOf(account, at, false);
  const held = state !== null && state.refused !== "outside_working_hours";
  return {
    quotaDay: day.quotaDay,
    left: held ? 0 : readsGrantable(account, day),
    windowOpen: isWindowOpen(at, timeZone, workingHours),
    nextWindowAt: nextWindowAt(at, timeZone, workingHours),
  };
}

/**
 * What the account may still send today, for campaigns' plan: limitsFor's answer over its quota day's
 * row, made when missing so that the plan sees the limits the reservations check, and the end of
 * today's window in the account's zone, null when none is left today. Nothing on Saturday and
 * Sunday in the account's zone (send/state.ts), nor while sending is closed, a kill switch is on
 * for the account, its health pauses it, its retry_at is still ahead, the sending disclosure is not
 * accepted or the member id is not known (decisions.md Finding 56), so the plan places nothing that
 * its reservation would refuse; no connection request while the platform's invites are paused, the
 * account is at_risk, or the pending invitations' count, with the invites in flight, refuses one.
 */
export async function remainingToday(accountId: string): Promise<RemainingToday> {
  const account = await findAccount(accountId);
  const at = now();
  const hours = sendHours(account.workingHours);
  const controls = await readControls();
  const closed = !controls.platform.sendingOpen || stopOf(controls, account) !== null;
  const paused =
    isPaused(account.healthState) || (account.retryAt !== null && account.retryAt > at);
  const unready = sendingDisclosureRequired(account) || !account.memberIdKnown;
  if (closed || paused || unready || hours === null || isWeekend(at, account.timeZone)) {
    return { invites: 0, messages: 0, withdrawals: 0, actions: 0, windowEnd: null };
  }
  const day = await dayOf(account, at, false);
  const usage = { invitesBefore: await invitesBefore(account.id, day.quotaDay) };
  const { invites, messages, withdrawals, actions } = limitsFor(account, day, usage);
  const window = windowLeft(at, account.timeZone, hours);
  const noInvite =
    controls.platform.invitesPaused ||
    account.healthState === "at_risk" ||
    (await heldRefusal(account, at)) !== null;
  const invitesLeft = noInvite ? 0 : invites;
  return { invites: invitesLeft, messages, withdrawals, actions, windowEnd: window?.to ?? null };
}
