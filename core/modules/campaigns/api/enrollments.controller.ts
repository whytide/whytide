// GET …/campaigns/enrollments?personId= (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/campaigns: the person's enrollments for the lead page's panel, read in
// the request's tenant run, so that another workspace's never come. A module cannot import the host,
// so the handler sets the host's metadata itself: its permission, and its @ApiRoute, which checks the
// query (400 validation_failed without personId) and documents the route (core/apps/api/README.md).
import { Controller, Get, Query, SetMetadata } from "@nestjs/common";
import { ENROLLMENTS_SHOWN } from "../domain/constants.ts";
import { enrollmentsOf, type PersonEnrollment } from "../domain/enrollments.ts";
import { permissions } from "../permissions.ts";
import {
  type EnrollmentsQuery,
  type EnrollmentsResponse,
  enrollmentsQuery,
  enrollmentsResponse,
} from "../schemas/enrollments.ts";

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
}

/** An enrollment as the route answers it, its instants in ISO 8601, UTC. */
function toResponse(enrollment: PersonEnrollment): EnrollmentsResponse["enrollments"][number] {
  const { startedAt, endedAt, steps, ...rest } = enrollment;
  return {
    ...rest,
    startedAt: iso(startedAt),
    endedAt: iso(endedAt),
    steps: steps.map(({ dueAt, scheduledFor, executedAt, ...step }) => ({
      ...step,
      dueAt: iso(dueAt),
      scheduledFor: iso(scheduledFor),
      executedAt: iso(executedAt),
    })),
  };
}

const iso = (at: Date | null) => at?.toISOString() ?? null;
