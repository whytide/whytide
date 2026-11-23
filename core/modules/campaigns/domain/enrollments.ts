// A person's enrollments for the lead page's panel (README.md "Routes"), in the caller's tenant run
// through its tenantClient, so another workspace's rows never come: newest first, at most
// ENROLLMENTS_SHOWN, each with its steps by position and its sender account's time zone, which
// linkedin's findSenderAccount answers: null without a sender, and for an account linkedin no longer
// holds; and its campaign's name, empty for the seeded campaign, and its pause (gamma-p3-060). Ids,
// codes and instants only, and the campaign's name: no message text, no provider reference.
import { tenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import {
  type ActionType,
  ENROLLMENTS_SHOWN,
  type EnrollmentPauseReason,
  type EnrollmentStatus,
  type ExitReason,
  type StepStatus,
} from "./constants.ts";

/** A step of an enrollment as the panel reads it. */
export type EnrolledStep = {
  readonly stepKey: string;
  readonly actionType: ActionType;
  readonly status: StepStatus;
  readonly dueAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly executedAt: Date | null;
  readonly skipReason: string | null;
  readonly errorCode: string | null;
};

/** One of the person's enrollments, with its sender's time zone and its steps by position. */
export type PersonEnrollment = {
  readonly id: string;
  readonly status: EnrollmentStatus;
  readonly exitReason: ExitReason | null;
  readonly exitDetail: string | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly campaignName: string;
  readonly pausedReason: EnrollmentPauseReason | null;
  readonly pausedUntil: Date | null;
  readonly timeZone: string | null;
  readonly steps: readonly EnrolledStep[];
};

const STEP_FIELDS = {
  stepKey: true,
  actionType: true,
  status: true,
  dueAt: true,
  scheduledFor: true,
  executedAt: true,
  skipReason: true,
  errorCode: true,
} as const;

/** The person's enrollments in the run's workspace: none for a person it does not hold. */
export async function enrollmentsOf(personId: string): Promise<PersonEnrollment[]> {
  // Prisma drops an undefined value from a where: unchecked, that would be every person's.
  if (typeof personId !== "string" || personId === "") return [];
  const rows = await tenantClient.enrollment.findMany({
    where: { personId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ENROLLMENTS_SHOWN,
    select: {
      id: true,
      status: true,
      exitReason: true,
      exitDetail: true,
      startedAt: true,
      endedAt: true,
      templateId: true,
      templateVersion: true,
      pausedReason: true,
      pausedUntil: true,
      senderAccountId: true,
    },
  });
  // Their campaigns' names in a query of their own; none for the seeded one before its row.
  const campaigns = await tenantClient.campaign.findMany({
    where: { keyRef: { in: [...new Set(rows.map(({ templateId }) => templateId))] } },
    select: { keyRef: true, name: true },
  });
  const names = new Map(campaigns.map(({ keyRef, name }) => [keyRef, name]));
  // Their steps in a query of their own: the tenant client refuses a relation in a query.
  const stepRows = await tenantClient.stepExecution.findMany({
    where: { enrollmentId: { in: rows.map(({ id }) => id) } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { enrollmentId: true, ...STEP_FIELDS },
  });
  const steps = new Map<string, EnrolledStep[]>();
  for (const { enrollmentId, ...step } of stepRows) {
    steps.set(enrollmentId, [...(steps.get(enrollmentId) ?? []), step]);
  }
  const zones = new Map<string, string | null>();
  for (const { senderAccountId: id } of rows) {
    if (id !== null && !zones.has(id)) zones.set(id, await timeZoneOf(id));
  }
  return rows.map(({ senderAccountId, ...enrollment }) => ({
    ...enrollment,
    campaignName: names.get(enrollment.templateId) ?? "",
    timeZone: senderAccountId === null ? null : (zones.get(senderAccountId) ?? null),
    steps: steps.get(enrollment.id) ?? [],
  }));
}

/** The account's zone; null when linkedin no longer holds the account in the run's workspace. */
async function timeZoneOf(senderAccountId: string): Promise<string | null> {
  try {
    return (await findSenderAccount(senderAccountId)).timeZone;
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}
