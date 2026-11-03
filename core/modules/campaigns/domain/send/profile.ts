// The profile read before a connection request (docs/flows.md "The read before an invite";
// beta-p4-030), for an invite whose person has no member id under MEMBER_REF_KEY, in the caller's
// tenant runs. The read is reserved in linkedin's quota after the claim's credits and before any
// slot, and logged as read_profile under the step; refused, the credits are freed and the step waits
// unplaced, until the refusal's time, with its code. Settled on linkedin's answer: a profile commits
// the read and stores the member id on the person through contacts, at the person's stored URL, so a
// changed profile URL never makes a second person; no profile (linkedin_not_found) commits the read,
// frees the credits, fails the step (profile_unreadable) and ends the enrollment (send_refused);
// another refusal commits the read too, and no answer releases it, the credits freed and the step
// waiting either way. workflows/profile.ts writes and reads the two files, outside the runs. A stored
// URL off the port's schema reserves no read and fails the step (linkedin_input_invalid), and a settle
// retried after its files are gone answers from the person (beta-p4-040).
import { cancelItems } from "@whytide/approvals";
import {
  errors as contactsErrors,
  getPerson,
  lockLeadStatus,
  type Person,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import {
  commitReads,
  type ProfileFile,
  profileRequestFile,
  releaseReads,
  reserveReads,
} from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { PENDING_STEP_STATUSES, STEP_NOT_READY } from "../gate/constants.ts";
import type { GateReason } from "../gate/gate.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES, type StepReasonCode } from "../steps/constants.ts";
import { finishLead, lockEnrollment } from "../steps/skip.ts";
import {
  INPUT_INVALID,
  MEMBER_REF_KEY,
  PROFILE_FILE,
  PROFILE_READ_KIND,
  PROFILE_REQUEST_FILE,
  PROFILE_SOURCE,
  REQUEST_FOLDER,
} from "./constants.ts";
import { blockClaimed } from "./gate.ts";
import { failStep } from "./recover.ts";
import { type Holds, releaseHolds, waitAgain } from "./release.ts";
import { profileReadWaitMs } from "./wait.ts";

/** The read reserved, with the person's stored URL for its request file; or why not. */
export type ProfileReserved =
  | { readonly reservationId: string; readonly profileUrl: string }
  | { readonly refused: string; readonly retryAt: string | null }
  | { readonly blocked: GateReason };
/** linkedin's answer as the settle takes it: the profile read, its refusal, or none at all. */
export type ProfileAnswer = { readonly profile: ProfileFile } | { readonly refused: string } | null;
/**
 * The read settled: whether the member id is stored now, when, and the wait before the slot; the
 * step ended (profile_unreadable), as the claim's block answers; or the step waiting, the run ending.
 */
export type ProfileSettled =
  | { readonly stored: boolean; readonly readAt: string; readonly waitMs: number }
  | { readonly blocked: GateReason }
  | { readonly refused: string; readonly retryAt: string | null };

const NOT_FOUND = "linkedin_not_found";
const UNREADABLE = "profile_unreadable";
/** The wait of a step whose read gave no member id and no code campaigns stores. */
const NO_MEMBER_REF = "member_ref_unknown";
const SYSTEM = { type: "system" } as const;

/** The step's two files under raw/: `raw/campaigns/<id>/profile.request.json` and `profile.json`. */
export function profileKeysOf(stepExecutionId: string): { requestKey: string; rawKey: string } {
  const folder = `${REQUEST_FOLDER}/${stepExecutionId}`;
  return { requestKey: `${folder}/${PROFILE_REQUEST_FILE}`, rawKey: `${folder}/${PROFILE_FILE}` };
}

/** Whether an invite's person has no member id known; false for one erased, whom the gate stops. */
export async function needsProfileRead(personId: string): Promise<boolean> {
  const person = await personOf(personId);
  if (person === null) return false;
  const ref = person.providerRefs?.[MEMBER_REF_KEY];
  return typeof ref !== "string" || ref === "";
}

/**
 * The read of the claimed, charged step reserved under its sender account, logged under the step;
 * refused, the credits freed and the step back to `scheduled`, unplaced, waiting until the refusal's
 * time with its code. A step no longer claimed, or a person erased meanwhile, frees the credits too;
 * a stored URL off the port's schema, a defect, fails the step at `at` before any read (beta-p4-040).
 */
export async function reserveProfileRead(
  id: string,
  holds: Holds,
  at: Date,
): Promise<ProfileReserved> {
  const where = { id, status: "executing" } as const;
  const select = { personId: true, senderAccountId: true } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select });
  if (step === null) return { blocked: (await blockClaimed(id, holds, STEP_NOT_READY)).reason };
  const person = await personOf(step.personId);
  if (person === null)
    return { blocked: (await blockClaimed(id, holds, "person_not_found")).reason };
  if (!profileRequestFile.safeParse({ profileUrl: person.linkedinUrl }).success) {
    await releaseHolds(holds);
    await failStep(id, INPUT_INVALID, true, at);
    return { blocked: INPUT_INVALID };
  }
  const accountId = step.senderAccountId;
  const read = await reserveReads({ accountId, count: 1, kind: PROFILE_READ_KIND, objectRef: id });
  if ("refused" in read) {
    await releaseHolds(holds);
    await waitAgain(where, waitCode(read.refused), read.retryAt);
    return { refused: read.refused, retryAt: read.retryAt?.toISOString() ?? null };
  }
  return { reservationId: read.reservationId, profileUrl: person.linkedinUrl };
}

/** The step's read settled at `at` on linkedin's answer (the file's header). */
export async function settleProfileRead(
  input: {
    readonly stepExecutionId: string;
    readonly holds: Holds;
    readonly reservationId: string;
    readonly answer: ProfileAnswer;
  },
  at: Date,
): Promise<ProfileSettled> {
  const { stepExecutionId: id, holds, reservationId, answer } = input;
  if (answer !== null && "profile" in answer) {
    await commitReads(reservationId, 1);
    const stored = await storeMemberRef(id, answer.profile);
    return { stored, readAt: at.toISOString(), waitMs: profileReadWaitMs() };
  }
  // The credits first, then linkedin's reservation, as every settle takes them (settle.ts).
  await releaseHolds(holds);
  // Any refusal commits the read, one linkedin answers before its call too (account_paused,
  // linkedin_rate_limited, beta-p6-020), as signals settles its reads: the safe side. No answer
  // past the read's attempts is taken as not made.
  if (answer === null) await releaseReads(reservationId);
  else await commitReads(reservationId, 1);
  const code = answer?.refused ?? NO_MEMBER_REF;
  if (code === NOT_FOUND) {
    await failUnreadable(id, at);
    return { blocked: UNREADABLE };
  }
  await waitAgain({ id, status: "executing" }, waitCode(code));
  return { refused: code, retryAt: null };
}

/**
 * The settle retried once the one before it deleted the files (workflows/profile.ts, beta-p4-040):
 * that one settled the read; whether the person has a member id now, and the wait from `at`.
 */
export async function settledBefore(id: string, at: Date): Promise<ProfileSettled> {
  const where = { id, status: "executing" } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select: { personId: true } });
  const person = step === null ? null : await personOf(step.personId);
  const ref = person?.providerRefs?.[MEMBER_REF_KEY];
  const stored = typeof ref === "string" && ref !== "";
  return { stored, readAt: at.toISOString(), waitMs: profileReadWaitMs() };
}

/**
 * The member id the read found, stored on the claimed step's person in contacts' providerRefs under
 * MEMBER_REF_KEY, with the profile's business fields, at the person's stored URL; whether it is
 * there now. A person erased meanwhile (person_not_found, person_erased) stores nothing: the gate
 * after the wait stops the step.
 */
async function storeMemberRef(id: string, profile: ProfileFile): Promise<boolean> {
  const where = { id, status: "executing" } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select: { personId: true } });
  const person = step === null ? null : await personOf(step.personId);
  if (person === null) return false;
  const { providerMemberRef, firstName, lastName, headline, title, companyName } = profile;
  const fields = { firstName, lastName, headline, title, companyName };
  try {
    const { person: stored } = await upsertPersonFromSource({
      source: PROFILE_SOURCE,
      provider: MEMBER_REF_KEY,
      profile: {
        ...{ linkedinUrl: person.linkedinUrl, providerId: providerMemberRef, ...fields },
        ...{ locationText: profile.locationText, fetchedAt: new Date(profile.fetchedAt) },
      },
    });
    return stored.providerRefs?.[MEMBER_REF_KEY] === providerMemberRef;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_erased) return false;
    throw error;
  }
}

/**
 * The connection request `failed` with profile_unreadable while still claimed, and its enrollment
 * `exited` (send_refused) while still active: its other pending steps cancelled with the code, their
 * pending items blocked, and the lead finished. The lead is locked first, then the enrollment, the
 * order every stop takes (../steps/skip.ts).
 */
async function failUnreadable(id: string, at: Date): Promise<void> {
  const where = { id, status: "executing" } as const;
  const select = { enrollmentId: true, personId: true, templateId: true } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select });
  if (step === null) return;
  const code = checkedCode(STEP_REASON_CODES, "error_code", UNREADABLE);
  await lockLeadStatus(step.personId);
  await lockEnrollment(tenantClient, step.enrollmentId);
  const failed = { status: "failed", errorCode: code } as const;
  if ((await tenantClient.stepExecution.updateMany({ where, data: failed })).count === 0) return;
  const pending = { in: [...PENDING_STEP_STATUSES] };
  const cancelled = await tenantClient.stepExecution.updateManyAndReturn({
    where: { enrollmentId: step.enrollmentId, id: { not: id }, status: pending },
    data: { status: "cancelled", skipReason: code },
    select: { id: true },
  });
  await cancelItems([id, ...cancelled.map((row) => row.id)]);
  const { count } = await tenantClient.enrollment.updateMany({
    where: { id: step.enrollmentId, status: "active" },
    data: { status: "exited", exitReason: "send_refused", endedAt: at },
  });
  if (count === 1) await finishLead(step, SYSTEM);
}

/** The code a waiting step stores: the refusal's when campaigns lists it, member_ref_unknown else. */
function waitCode(code: string): StepReasonCode {
  return (STEP_REASON_CODES as readonly string[]).includes(code)
    ? (code as StepReasonCode)
    : NO_MEMBER_REF;
}

/** contacts' person, or null for one erased meanwhile. */
async function personOf(personId: string): Promise<Person | null> {
  try {
    return await getPerson(personId);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
    throw error;
  }
}
