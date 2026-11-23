// Pausing one person's enrollment (README.md "Pausing"; docs/flows.md "Pausing"), each command in
// the caller's tenant run, the lead then the enrollment locked, the order every stop takes:
// pauseEnrollment moves an `active` enrollment to `paused` with its reason and, when given, the
// time it resumes at; resumeEnrollment moves it back, clearing the code its steps waited on. While
// it is paused, the queue opens nothing of it, the plan places nothing and the gate blocks a claim,
// the step put back unplaced (status.ts); it is still live for the stops, the acceptance and the
// fallback. resumeDueEnrollments, at the queue run's start (workflows/index.ts
// campaigns_due_steps), resumes those whose time has passed. pauseEnrollment and resumeEnrollment
// are gamma-p4-050's too. The routes first ask assertEnrollmentWriter (gamma-p6-015).
import { lockLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, canWriteOwned, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { permissions } from "../../permissions.ts";
import { campaignByKey } from "../campaigns/reads.ts";
import {
  ENROLLMENT_PAUSE_REASONS,
  type EnrollmentPauseReason,
  type EnrollmentStatus,
  NO_PAUSE,
} from "../constants.ts";
import { requireInstant } from "../gate/instant.ts";
import type { PauseCode } from "../steps/constants.ts";
import { lockEnrollment } from "../steps/skip.ts";

/** An enrollment's pause as the commands answer it. */
export type EnrollmentPause = {
  readonly id: string;
  readonly status: EnrollmentStatus;
  readonly pausedReason: EnrollmentPauseReason | null;
  readonly pausedUntil: Date | null;
};

/**
 * The active enrollment `paused` for `reason`, until `until` when given (a time past resumes it at
 * the next queue run), else until a member resumes it; enrollment_not_found, enrollment_not_active.
 */
export async function pauseEnrollment(
  enrollmentId: string,
  options: { readonly until?: Date | null; readonly reason: EnrollmentPauseReason },
): Promise<EnrollmentPause> {
  const until = options?.until == null ? null : requireInstant(options.until, "until");
  const reason = options?.reason;
  if (!(ENROLLMENT_PAUSE_REASONS as readonly unknown[]).includes(reason)) {
    throw new Error(`pauseEnrollment: a reason of ${ENROLLMENT_PAUSE_REASONS.join(", ")}`);
  }
  const { status } = await locked(enrollmentId);
  if (status !== "active") throw new AppError(errors.enrollment_not_active);
  const paused = { status: "paused", pausedReason: reason, pausedUntil: until } as const;
  await tenantClient.enrollment.updateMany({
    where: { id: enrollmentId, status: "active" },
    data: paused,
  });
  return { id: enrollmentId, ...paused };
}

/** The paused enrollment `active` again; enrollment_not_found, enrollment_not_paused. */
export async function resumeEnrollment(enrollmentId: string): Promise<EnrollmentPause> {
  const { status } = await locked(enrollmentId);
  if (status !== "paused") throw new AppError(errors.enrollment_not_paused);
  await resume(enrollmentId);
  return { id: enrollmentId, status: "active", ...NO_PAUSE };
}

/**
 * Whether the caller may pause or resume the enrollment by its routes (README.md "Decided here"):
 * its campaign's owner, or a holder of campaigns.manage, through platform's canWriteOwned; anyone
 * else is forbidden, before anything is written. An enrollment whose campaign has no row yet (beta's
 * template before its seed) is the workspace's; enrollment_not_found first. The reply label's pause
 * (gamma-p4-050) and the timed resume act for the lead, not on the campaign, and do not ask it.
 */
export async function assertEnrollmentWriter(enrollmentId: string): Promise<void> {
  const found =
    typeof enrollmentId === "string" && enrollmentId !== ""
      ? await tenantClient.enrollment.findFirst({
          where: { id: enrollmentId },
          select: { templateId: true },
        })
      : null;
  if (found === null) throw new AppError(errors.enrollment_not_found);
  const campaign = await campaignByKey(found.templateId);
  const ownerUserId = campaign?.ownerUserId ?? null;
  const owned = { ownerUserId, manageAction: permissions["campaigns.manage"] };
  const decision = canWriteOwned(currentTenant().principal, owned);
  if (decision !== "allow") throw new AppError(decision);
}

/** The paused enrollments whose time has passed by `at` resumed, each under its locks: how many. */
export async function resumeDueEnrollments(at: Date): Promise<number> {
  const now = requireInstant(at, "at");
  const due = await tenantClient.enrollment.findMany({
    where: { status: "paused", pausedUntil: { lte: now } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  let resumed = 0;
  for (const { id } of due) {
    const { status, pausedUntil } = await locked(id);
    // Read again under the locks: a member may have resumed it, or paused it anew, meanwhile.
    if (status !== "paused" || pausedUntil === null || pausedUntil > now) continue;
    await resume(id);
    resumed += 1;
  }
  return resumed;
}

/** The enrollment's lead, then its row, locked until the run ends; read under them. */
async function locked(enrollmentId: string) {
  // Prisma drops an undefined value from a where: unchecked, that would be any enrollment.
  const found =
    typeof enrollmentId === "string" && enrollmentId !== ""
      ? await tenantClient.enrollment.findFirst({
          where: { id: enrollmentId },
          select: { personId: true },
        })
      : null;
  if (found === null) throw new AppError(errors.enrollment_not_found);
  await lockLeadStatus(found.personId);
  await lockEnrollment(tenantClient, enrollmentId);
  return tenantClient.enrollment.findFirstOrThrow({
    where: { id: enrollmentId },
    select: { status: true, pausedUntil: true },
  });
}

/** Back to `active`, and its steps no longer wait on the pause: the plan places them again. */
async function resume(enrollmentId: string): Promise<void> {
  await tenantClient.enrollment.updateMany({
    where: { id: enrollmentId, status: "paused" },
    data: { status: "active", ...NO_PAUSE },
  });
  await tenantClient.stepExecution.updateMany({
    where: {
      enrollmentId,
      status: "scheduled",
      errorCode: "enrollment_paused" satisfies PauseCode,
    },
    data: { errorCode: null },
  });
}
