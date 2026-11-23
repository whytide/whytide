// The acceptance and the first message (README.md "Acceptance and the first message"; docs/flows.md
// "Acceptance → the first message"; briefs RB-9.2.2, RB-11.2.4). firstMessageDueAt, pure but for
// its source of numbers: the first message's earliest time, a draw of 1 to 3 hours after the
// acceptance is detected, never within 10 minutes of it, moved to the next window start on a weekday
// when it falls outside the sender account's window. recordAcceptance, the body of the subscriber to
// linkedin.invite_accepted (events.ts), in the delivery's transaction: the lead locked, then the
// person's live enrollment with the account, a paused one too, then its steps, the order every stop
// takes (gamma-p3-060; before it, never the lead); the connection request's accepted_at, the
// detection, while it is null and the request went out; then every pending step of the email
// fallback skipped with invite_accepted, its item blocked (fallback/), and the enrollment ended if
// nothing is left of it; then the first LinkedIn message's due time, while it is planned without
// one: the step of the enrollment's campaign version anchored on the acceptance, found by its key
// (gamma-p3-030), none in a version without a LinkedIn message. The delay counts from the
// detection, never from LinkedIn's acceptance time: an invite without a note can be reported hours
// late (docs/07 §5.3). No LinkedIn step's status changes here, since only the sender settles them,
// and no provider is called; the queue opens message_1's item once it is due within its window
// (queue/), and after the resume for a paused enrollment.
import { lockLeadStatus } from "@whytide/contacts";
import type { TenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import {
  currentTenant,
  isAppError,
  isWindowOpen,
  type LocalHours,
  MONDAY_TO_FRIDAY,
  nextWindowAt,
  randomTimesInWindow,
} from "@whytide/platform";
import { STEP_KEYS } from "./campaigns/constants.ts";
import { versionSteps } from "./campaigns/reads.ts";
import type { VersionStep } from "./campaigns/sequence.ts";
import { random as chance } from "./clock.ts";
import { MS_PER_HOUR, MS_PER_MINUTE, WENT_OUT_STATUSES, WINDOW_STARTS_TRIED } from "./constants.ts";
import { fallbackKeys, skipFallback } from "./fallback/fallback.ts";
import { requireInstant } from "./gate/instant.ts";
import { endIfDone } from "./steps/skip.ts";
import { FIRST_MESSAGE_DELAY_HOURS, MIN_MINUTES_AFTER_ACCEPTANCE } from "./template/constants.ts";

/** Every version's connection request, whose acceptance is recorded, and its first message. */
const [INVITE_KEY] = STEP_KEYS.invite;
const [FIRST_MESSAGE_KEY] = STEP_KEYS.message;

/** A sender account's time as the due time reads it: its IANA zone and its working hours. */
export type AccountHours = { readonly timeZone: string; readonly workingHours: LocalHours };

/** linkedin.invite_accepted as the subscriber reads it: ids, and when Whytide learned of it. */
export type InviteAccepted = {
  readonly senderAccountId: string;
  readonly personId: string;
  readonly detectedAt: Date;
};

/**
 * What a delivery did: nothing; the acceptance recorded alone (message_1 not planned without a due
 * time, or no window to place it in); or that and message_1's due time.
 */
export type AcceptanceOutcome = "unchanged" | "accepted" | "due";

const STEP_FIELDS = {
  id: true,
  stepKey: true,
  status: true,
  dueAt: true,
  acceptedAt: true,
} as const;
/** The first message's step as its due time reads it. */
type MessageStep = { readonly id: string; readonly status: string; readonly dueAt: Date | null };

/**
 * The first message's due time after an acceptance detected at `detectedAt`: the detection plus a
 * uniform draw in FIRST_MESSAGE_DELAY_HOURS, never under MIN_MINUTES_AFTER_ACCEPTANCE after it; when
 * that falls outside the account's window, its days cut to Monday to Friday, the next window start
 * where the window is open, so a start whose whole window a spring-forward skips is passed over. Null
 * when the account's days hold no weekday: no window ever opens. `random` gives numbers in [0, 1);
 * any other value throws (platform's time_argument_invalid) and places no time.
 */
export function firstMessageDueAt(
  detectedAt: Date,
  account: AccountHours,
  random: () => number,
): Date | null {
  const detected = requireInstant(detectedAt, "detectedAt").getTime();
  const { timeZone, workingHours } = account;
  const days = MONDAY_TO_FRIDAY.filter((day) => workingHours.days.includes(day));
  if (days.length === 0) return null;
  const hours: LocalHours = { ...workingHours, days };
  const from = new Date(detected + FIRST_MESSAGE_DELAY_HOURS.min * MS_PER_HOUR);
  const to = new Date(detected + FIRST_MESSAGE_DELAY_HOURS.max * MS_PER_HOUR);
  const [drawn = from] = randomTimesInWindow({ from, to, count: 1, minGapMs: 0, random });
  const earliest = new Date(detected + MIN_MINUTES_AFTER_ACCEPTANCE * MS_PER_MINUTE);
  let due = drawn > earliest ? drawn : earliest;
  for (let tried = 0; !isWindowOpen(due, timeZone, hours); tried += 1) {
    if (tried === WINDOW_STARTS_TRIED) return null;
    due = nextWindowAt(due, timeZone, hours);
  }
  return due;
}

/**
 * The acceptance recorded on the person's live enrollment with the account, in the delivery's
 * transaction (the file's header). A redelivery, or the daily check's acceptance of the same person,
 * finds accepted_at set and changes nothing; so does an enrollment that ended, a connection request
 * that never went out, or another account's acceptance.
 */
export async function recordAcceptance(
  tx: TenantClient,
  accepted: InviteAccepted,
): Promise<AcceptanceOutcome> {
  const detectedAt = requireInstant(accepted.detectedAt, "detectedAt");
  await lockLeadStatus(accepted.personId);
  const enrollment = await lockLiveEnrollment(tx, accepted);
  if (enrollment === null) return "unchanged";
  const { id: enrollmentId, template_id: templateId, template_version: versionNo } = enrollment;
  // The version's first LinkedIn message, whose delay counts from the acceptance's detection.
  const versioned = await versionSteps(templateId, versionNo);
  const firstMessage = firstMessageOf(versioned ?? []);
  const keys = firstMessage === undefined ? [INVITE_KEY] : [INVITE_KEY, firstMessage];
  const steps = await tx.stepExecution.findMany({
    where: { enrollmentId, stepKey: { in: keys } },
    select: STEP_FIELDS,
  });
  const invite = steps.find(({ stepKey }) => stepKey === INVITE_KEY);
  if (invite === undefined || invite.acceptedAt !== null || !wentOut(invite.status)) {
    return "unchanged";
  }
  // Conditional on the request still out, not on the status read: the sender may settle it meanwhile.
  const { count } = await tx.stepExecution.updateMany({
    where: { id: invite.id, status: { in: [...WENT_OUT_STATUSES] }, acceptedAt: null },
    data: { acceptedAt: detectedAt },
  });
  if (count === 0) return "unchanged";
  // The fallback's emails go only while the request is not accepted: none of them goes now.
  const skipped = await skipFallback(tx, enrollmentId, fallbackKeys(versioned ?? []));
  if (skipped.length > 0) {
    const ended = { enrollmentId, personId: accepted.personId, templateId };
    if (await endIfDone(tx, ended, detectedAt, SYSTEM)) return "accepted";
  }
  const message = steps.find(({ stepKey }) => stepKey === firstMessage);
  const due = await dueFirstMessage(tx, message, accepted.senderAccountId, detectedAt);
  return due ? "due" : "accepted";
}

/** The version's first LinkedIn message, anchored on the acceptance, by its key; none without one. */
export const firstMessageOf = (versioned: readonly VersionStep[]): string | undefined =>
  versioned.find(
    ({ stepKey, delay }) => stepKey === FIRST_MESSAGE_KEY && delay.anchor === "accepted",
  )?.stepKey;

/**
 * The first message due at its time after `at` (firstMessageDueAt, the sender account's hours), while
 * it is still `planned` without a due time, in the caller's transaction: whether it is due now. The
 * acceptance sets it so, and the skip of a connection request whose person is a connection already
 * (send/connected.ts, connect-already-connected).
 */
export async function dueFirstMessage(
  tx: TenantClient,
  message: MessageStep | undefined,
  senderAccountId: string,
  at: Date,
): Promise<boolean> {
  if (message === undefined || message.status !== "planned" || message.dueAt !== null) return false;
  // An account linkedin no longer holds, or one with no weekday: nothing could go from it.
  const account = await accountOf(senderAccountId);
  const dueAt = account === null ? null : firstMessageDueAt(at, account, chance);
  if (dueAt === null) return false;
  const due = await tx.stepExecution.updateMany({
    where: { id: message.id, status: "planned", dueAt: null },
    data: { dueAt },
  });
  return due.count === 1;
}

/** A live enrollment as the acceptance locks it: its id and the version it joined. */
type LockedEnrollment = { id: string; template_id: string; template_version: number };

/**
 * The person's live enrollment with the account, active or paused, its row locked until the
 * delivery ends; null for none. A hold that ended it meanwhile is waited for, and its row then no
 * longer matches.
 */
async function lockLiveEnrollment(
  tx: TenantClient,
  accepted: InviteAccepted,
): Promise<LockedEnrollment | null> {
  const { workspaceId } = currentTenant();
  const { personId, senderAccountId } = accepted;
  const [enrollment] = await tx.$queryRaw<LockedEnrollment[]>`
    SELECT id, template_id, template_version FROM enrollments
    WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
      AND sender_account_id = ${senderAccountId} AND status IN ('active', 'paused')
    FOR UPDATE`;
  return enrollment ?? null;
}

/** The acceptance's own end of an enrollment is the system's. */
const SYSTEM = { type: "system" } as const;

const wentOut = (status: string): boolean =>
  (WENT_OUT_STATUSES as readonly string[]).includes(status);

/**
 * The account's zone and hours; null once linkedin no longer holds it in the run's workspace. The
 * queue's recovery of a first message reads it too (queue/recover.ts).
 */
export async function accountOf(senderAccountId: string): Promise<AccountHours | null> {
  try {
    return await findSenderAccount(senderAccountId);
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}
