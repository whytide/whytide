// The account's state before an action (docs/concepts.md "Send reservation", "Kill switches"): the
// refusals that do not depend on the day's budgets, read in the caller's run from Postgres, never from
// a cache: the switches (domain/controls/) and the account as the run has just read it. reserveSend
// asks sendStateRefusal first, and the send activity again just before the port call (beta-p1-050):
// a repeat of a key answers its hold without asking, so that call is what stops a send reserved
// before a switch. reserveReads asks readStateRefusal. The account's health (domain/health/) right
// after its status: account_paused for restricted, checkpoint and disconnected, and an invite
// invites_paused while at_risk. After invites_paused, the risk disclosure's (domain/disclosure/): an
// owner who has not accepted it for sending; then, for an invite, the pending invitations' count
// with the invites in flight (domain/invites/), failing closed; then a member id not read since the
// account's latest pairing, or LINKEDIN_HASH_KEY empty. Reads ask none of these. A read's port call
// asks the switches, the status, the health and retry_at again (readCallRefusal).
import { isWindowOpen, nextWindowAt } from "@whytide/platform";
import type { SendActionType } from "../../schemas/quota.ts";
import type { SenderAccount } from "../accounts.ts";
import { type Controls, readControls, type StopCode, stopOf } from "../controls/controls.ts";
import { sendingDisclosureRequired } from "../disclosure/disclosure.ts";
import { isPaused } from "../health/states.ts";
import { PENDING_CHECK_RETRY_MS } from "../invites/constants.ts";
import { heldRefusal } from "../invites/held.ts";
import { dayOf } from "../quota/days.ts";
import { dayEndsAt, isoDayAt } from "../quota/limits.ts";
import type { WorkingHours } from "../working-hours.ts";
import { WEEKEND_DAYS } from "./constants.ts";

export type ReadStateRefusal = {
  readonly refused:
    | StopCode
    | "linkedin_account_disconnected"
    | "account_paused"
    | "rate_limited"
    | "outside_working_hours";
  /** retry_at for rate_limited; the next window's start; null for a switch, no window or no connection. */
  readonly retryAt: Date | null;
};
export type StateRefusal = {
  readonly refused:
    | ReadStateRefusal["refused"]
    | "sending_closed"
    | "invites_paused"
    | "disclosure_required"
    | "pending_invites_unknown"
    | "pending_invites_over_limit"
    | "member_id_unknown";
  readonly retryAt: Date | null;
};
type StateAccount = Pick<
  SenderAccount,
  "status" | "healthState" | "retryAt" | "timeZone" | "workingHours" | "killSwitch"
>;

/**
 * A send's state refusal at `at`, or null, in this order: sending closed on the instance (no platform
 * row, or `sending_open` false); a kill switch, the platform's, the workspace's, the account's; an
 * account not `connected`; its health restricted, checkpoint or disconnected; an invite while the
 * platform's invites are paused or the account is at_risk; the sending disclosure not accepted, with
 * the personal-account confirmation; an invite while the pending invitations' count is unknown,
 * stale or, with the invites in flight but `own` (the gate's reservation), above the limit
 * (invitesRefusal); no member id stored, or no key; `retry_at` still ahead; outside its window,
 * which for a send never opens on Saturday or Sunday in the account's zone, whatever days it lists,
 * with the next weekday window's start (null when it lists no weekday).
 */
export async function sendStateRefusal(
  account: SenderAccount,
  actionType: SendActionType,
  at: Date,
  own?: string,
): Promise<StateRefusal | null> {
  const controls = await readControls();
  if (!controls.platform.sendingOpen) return { refused: "sending_closed", retryAt: null };
  const stop = stopOf(controls, account);
  if (stop !== null) return { refused: stop, retryAt: null };
  if (account.status !== "connected") {
    return { refused: "linkedin_account_disconnected", retryAt: null };
  }
  if (isPaused(account.healthState)) return { refused: "account_paused", retryAt: null };
  const invitesPaused = controls.platform.invitesPaused || account.healthState === "at_risk";
  if (actionType === "invite" && invitesPaused) return { refused: "invites_paused", retryAt: null };
  if (sendingDisclosureRequired(account)) return { refused: "disclosure_required", retryAt: null };
  if (actionType === "invite") {
    const pending = await invitesRefusal(account, at, own);
    if (pending !== null) return pending;
  }
  if (!account.memberIdKnown) return { refused: "member_id_unknown", retryAt: null };
  return timeRefusal(account, at, sendHours(account.workingHours));
}

/**
 * An invite's refusal for the pending invitations' count (invites/held.ts), in the caller's run:
 * unknown while today's check is still to come (a check_after, no checked_at), until the hourly run
 * after it, PENDING_CHECK_RETRY_MS after check_after or after now once that has passed; else, and
 * over the limit, the next quota day's start. Today's row is made when missing, as remainingToday
 * makes it.
 */
async function invitesRefusal(
  account: SenderAccount,
  at: Date,
  own: string | undefined,
): Promise<StateRefusal | null> {
  const refused = await heldRefusal(account, at, own);
  if (refused === null) return null;
  const day = await dayOf(account, at, false);
  const { checkAfter, checkedAt } = day;
  if (refused === "pending_invites_unknown" && checkAfter !== null && checkedAt === null) {
    const after = Math.max(checkAfter.getTime(), at.getTime());
    return { refused, retryAt: new Date(after + PENDING_CHECK_RETRY_MS) };
  }
  return { refused, retryAt: dayEndsAt(day, account.timeZone) };
}

/**
 * A read's state refusal at `at`, or null: a kill switch, then as a send's, in the account's own
 * working days; sending closed and the invites' pause, the platform's or at_risk, gate sends only.
 */
export async function readStateRefusal(
  account: StateAccount,
  at: Date,
): Promise<ReadStateRefusal | null> {
  const stop = stopOf(await readControls(), account);
  if (stop !== null) return { refused: stop, retryAt: null };
  if (account.status !== "connected") {
    return { refused: "linkedin_account_disconnected", retryAt: null };
  }
  if (isPaused(account.healthState)) return { refused: "account_paused", retryAt: null };
  return timeRefusal(account, at, account.workingHours);
}

/** A read's refusal just before its port call (readCallRefusal). */
export type ReadCallRefusal =
  | StopCode
  | "linkedin_account_disconnected"
  | "account_paused"
  | "linkedin_rate_limited";

/**
 * A read's refusal just before its port call, on every attempt (workflows/index.ts), in its
 * reservation's order but the window: a kill switch, its code; not `connected`,
 * linkedin_account_disconnected; restricted, checkpoint or disconnected, account_paused; its retry_at
 * ahead, linkedin_rate_limited; else null. Answered, not thrown, so that no retry waits on it.
 */
export function readCallRefusal(
  account: Pick<StateAccount, "status" | "healthState" | "retryAt" | "killSwitch">,
  controls: Controls,
  at: Date,
): ReadCallRefusal | null {
  const stop = stopOf(controls, account);
  if (stop !== null) return stop;
  if (account.status !== "connected") return "linkedin_account_disconnected";
  if (isPaused(account.healthState)) return "account_paused";
  return account.retryAt !== null && account.retryAt > at ? "linkedin_rate_limited" : null;
}

/** The account's working hours on weekdays only; null when it lists Saturday and Sunday alone. */
export function sendHours(hours: WorkingHours): WorkingHours | null {
  const days = hours.days.filter((day) => !WEEKEND_DAYS.includes(day));
  return days.length === 0 ? null : { ...hours, days };
}

/** Saturday or Sunday at `at` in the zone: nothing is sent then, whatever days the account lists. */
export const isWeekend = (at: Date, timeZone: string): boolean =>
  WEEKEND_DAYS.includes(isoDayAt(at, timeZone));

function timeRefusal(
  account: StateAccount,
  at: Date,
  hours: WorkingHours | null,
): ReadStateRefusal | null {
  if (account.retryAt !== null && account.retryAt > at) {
    return { refused: "rate_limited", retryAt: account.retryAt };
  }
  if (hours === null) return { refused: "outside_working_hours", retryAt: null };
  // Asked at every reservation: a start that a daylight-saving gap moves can fall outside its window.
  if (!isWindowOpen(at, account.timeZone, hours)) {
    return { refused: "outside_working_hours", retryAt: nextWindowAt(at, account.timeZone, hours) };
  }
  return null;
}
