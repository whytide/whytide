// The ramp (docs/concepts.md "Ramp"; briefs RB-11.2.3), pure: once a quota day, an account that is
// actually sending raises its targets a step, up to INVITES_PER_DAY and MESSAGES_PER_DAY's `target`,
// and one idle for RAMP_IDLE_DAYS restarts at half. It counts sending, not the calendar: a target
// rises only when a send of its type was committed since the last step, never while sending is
// closed, a kill switch holds, the account is not connected or its health is not healthy; an idle
// account halves even then, so one that could not act for RAMP_IDLE_DAYS resumes at half. A second
// answer the same day is no change, and no answer leaves the targets' bounds, linkedin_send_quotas'
// CHECKs. The owner's resume after a cool-down halves the targets by the same rule (halvedTargets).
import type { SenderAccountStatus } from "../accounts.ts";
import { type Controls, stopOf } from "../controls/controls.ts";
import type { HealthState } from "../health/states.ts";
import { INVITES_PER_DAY, MESSAGES_PER_DAY } from "../quota/constants.ts";
import { quotaDayBefore } from "../quota/limits.ts";
import {
  RAMP_EVERY_DAYS,
  RAMP_IDLE_DAYS,
  RAMP_INVITE_STEP,
  RAMP_MESSAGE_STEP,
  RAMP_RESTART_SHARE,
} from "./constants.ts";

/** What the ramp reads of an account: its state, its switches, its targets and its last step. */
export type RampAccount = {
  readonly status: SenderAccountStatus;
  readonly healthState: HealthState;
  readonly killSwitch: boolean;
  readonly controls: Controls;
  readonly inviteTarget: number;
  readonly messageTarget: number;
  /** The quota day the ramp last moved it, `YYYY-MM-DD`; null before its first. */
  readonly rampUpdatedOn: string | null;
};
/** The connection requests and messages committed on one quota day (sender_quota_usage). */
export type DaySends = {
  readonly quotaDay: string;
  readonly invites: number;
  readonly messages: number;
};
/** The account's new targets and the day of the change. */
export type RampChange = {
  readonly inviteTarget: number;
  readonly messageTarget: number;
  readonly rampUpdatedOn: string;
};
type Bounds = { readonly start: number; readonly target: number };

/**
 * The account's change on its quota day `today`, or null for none, by these rules, rule 2 asked
 * first, so that an idle account halves whether it can act or not:
 * 1. not eligible (sending closed, a kill switch, not `connected`, its health not `healthy`): none;
 * 2. idle, no committed send in the RAMP_IDLE_DAYS quota days before today: each target at most half
 *    its final target, rounded down, never below its start, and the day; none when that is so
 *    already; while not eligible, a change only when a target falls, never the day alone;
 * 3. no step yet: the day, no rise;
 * 4. fewer than RAMP_EVERY_DAYS quota days since the last step: none;
 * 5. each target a step up, at most its final target, when a send of its type was committed on a
 *    quota day after the last step; the day when either rose, else none.
 * `sends` holds today and the RAMP_IDLE_DAYS quota days before it, and, of the days before those
 * since the last step, at least the first with a send of each type.
 */
export function rampStep(
  account: RampAccount,
  today: string,
  sends: readonly DaySends[],
): RampChange | null {
  const { inviteTarget, messageTarget, rampUpdatedOn } = account;
  const canAct = eligible(account);
  const idleFrom = quotaDayBefore(today, RAMP_IDLE_DAYS);
  const recent = sends.filter((day) => day.quotaDay >= idleFrom && day.quotaDay < today);
  if (!recent.some((day) => day.invites > 0 || day.messages > 0)) {
    const restart = { ...halvedTargets(account), rampUpdatedOn: today };
    if (!canAct) return lowered(account, restart) ? restart : null;
    return unchanged(account, restart) ? null : restart;
  }
  if (!canAct) return null;
  if (rampUpdatedOn === null) return { inviteTarget, messageTarget, rampUpdatedOn: today };
  if (rampUpdatedOn > quotaDayBefore(today, RAMP_EVERY_DAYS)) return null;
  const since = sends.filter((day) => day.quotaDay > rampUpdatedOn && day.quotaDay <= today);
  const invited = since.some((day) => day.invites > 0);
  const messaged = since.some((day) => day.messages > 0);
  const step = {
    inviteTarget: invited
      ? bounded(inviteTarget + RAMP_INVITE_STEP, INVITES_PER_DAY)
      : inviteTarget,
    messageTarget: messaged
      ? bounded(messageTarget + RAMP_MESSAGE_STEP, MESSAGES_PER_DAY)
      : messageTarget,
    rampUpdatedOn: today,
  };
  const rose = step.inviteTarget !== inviteTarget || step.messageTarget !== messageTarget;
  return rose ? step : null;
}

/**
 * The targets at half, the idle restart's and the owner's resume's (beta-p6-040): each the smaller of
 * its value and restartAt; 15 and 40 give 7 and 20, 5 and 10 stay.
 */
export function halvedTargets(
  targets: Pick<RampChange, "inviteTarget" | "messageTarget">,
): Pick<RampChange, "inviteTarget" | "messageTarget"> {
  const half = (value: number, bounds: Bounds) =>
    bounded(Math.min(value, restartAt(bounds)), bounds);
  return {
    inviteTarget: half(targets.inviteTarget, INVITES_PER_DAY),
    messageTarget: half(targets.messageTarget, MESSAGES_PER_DAY),
  };
}

/** Sending open on the instance, no kill switch over the account, `connected` and `healthy`. */
function eligible(account: RampAccount): boolean {
  if (!account.controls.platform.sendingOpen) return false;
  if (stopOf(account.controls, account) !== null) return false;
  return account.status === "connected" && account.healthState === "healthy";
}

/** Whether a target falls. */
const lowered = (account: RampAccount, change: RampChange): boolean =>
  change.inviteTarget < account.inviteTarget || change.messageTarget < account.messageTarget;

/** An idle account's restart: half its final target, rounded down, never below its start. */
const restartAt = ({ start, target }: Bounds): number =>
  Math.max(Math.floor(target * RAMP_RESTART_SHARE), start);

/** The value inside the target's bounds: from its start to its final target. */
const bounded = (value: number, { start, target }: Bounds): number =>
  Math.min(Math.max(value, start), target);

const unchanged = (account: RampAccount, change: RampChange): boolean =>
  change.inviteTarget === account.inviteTarget &&
  change.messageTarget === account.messageTarget &&
  change.rampUpdatedOn === account.rampUpdatedOn;
