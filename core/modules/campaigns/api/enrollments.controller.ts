// GET …/campaigns/enrollments?personId= (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/campaigns: the person's enrollments for the lead page's panel, read
// in the request's tenant run, so that another workspace's never come. POST
// …/campaigns/enrollments/:enrollmentId/pause and …/resume (gamma-p3-060) pause an active
// enrollment as a member's, until a time when given, and resume it, under campaigns.write, once
// assertEnrollmentWriter allowed the caller, its campaign's owner or campaigns.manage's. A module
// cannot import the host, so each handler sets the host's metadata itself: its permission, and its
// @ApiRoute, which checks the query, the path and the body (400 validation_failed) and documents
// the route (core/apps/api/README.md).
import { Body, Controller, Get, HttpCode, Param, Post, Query, SetMetadata } from "@nestjs/common";
import { ENROLLMENTS_SHOWN } from "../domain/constants.ts";
import { enrollmentsOf, type PersonEnrollment } from "../domain/enrollments.ts";
import {
  assertEnrollmentWriter,
  type EnrollmentPause,
  pauseEnrollment,
  resumeEnrollment,
} from "../domain/pause/enrollment.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type EnrollmentPauseBody,
  type EnrollmentPauseResponse,
  type EnrollmentsQuery,
  type EnrollmentsResponse,
  enrollmentParams,
  enrollmentPauseBody,
  enrollmentPauseResponse,
  enrollmentsQuery,
  enrollmentsResponse,
} from "../schemas/enrollments.ts";

const write = SetMetadata("whytide:permission", permissions["campaigns.write"]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller("enrollments")
export class EnrollmentsController {
  @Get()
  @SetMetadata("whytide:permission", permissions["campaigns.read"])
  @SetMetadata("whytide:api-route", {
    summary: `The person's enrollments, newest first, at most ${ENROLLMENTS_SHOWN}, each with its steps by position and its sender account's time zone`,
    query: enrollmentsQuery,
    response: enrollmentsResponse,
  })
  async list(@Query() { personId }: EnrollmentsQuery): Promise<EnrollmentsResponse> {
    return { enrollments: (await enrollmentsOf(personId)).map(toResponse) };
  }

  @Post(":enrollmentId/pause")
  @HttpCode(200)
  @write
  @route({
    summary:
      "Pauses the active enrollment as a member's, until the time given or until a member resumes it: none of its steps is opened, placed or sent meanwhile, and a reply or a suppression still ends it; the enrollment's status and pause",
    params: enrollmentParams,
    body: enrollmentPauseBody,
    response: enrollmentPauseResponse,
    errors: [errors.enrollment_not_found, errors.enrollment_not_active],
  })
  async pause(
    @Param("enrollmentId") enrollmentId: string,
    @Body() body: EnrollmentPauseBody,
  ): Promise<EnrollmentPauseResponse> {
    const until = body.until === undefined ? null : new Date(body.until);
    await assertEnrollmentWriter(enrollmentId);
    return pauseResponse(await pauseEnrollment(enrollmentId, { until, reason: "user" }));
  }

  @Post(":enrollmentId/resume")
  @HttpCode(200)
  @write
  @route({
    summary:
      "Resumes the paused enrollment: its steps go on from the next runs; the enrollment's status and pause",
    params: enrollmentParams,
    response: enrollmentPauseResponse,
    errors: [errors.enrollment_not_found, errors.enrollment_not_paused],
  })
  async resume(@Param("enrollmentId") enrollmentId: string): Promise<EnrollmentPauseResponse> {
    await assertEnrollmentWriter(enrollmentId);
    return pauseResponse(await resumeEnrollment(enrollmentId));
  }
}

/** An enrollment's pause as the routes answer it, its instant in ISO 8601, UTC. */
function pauseResponse(enrollment: EnrollmentPause): EnrollmentPauseResponse {
  return { ...enrollment, pausedUntil: iso(enrollment.pausedUntil) };
}

/** An enrollment as the route answers it, its instants in ISO 8601, UTC. */
function toResponse(enrollment: PersonEnrollment): EnrollmentsResponse["enrollments"][number] {
  const { startedAt, endedAt, pausedUntil, steps, ...rest } = enrollment;
  return {
    ...rest,
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    pausedUntil: iso(pausedUntil),
    steps: steps.map(({ dueAt, scheduledFor, executedAt, ...step }) => ({
      ...step,
      dueAt: iso(dueAt),
      scheduledFor: iso(scheduledFor),
      executedAt: iso(executedAt),
    })),
  };
}

const iso = (at: Date | null) => at?.toISOString() ?? null;
