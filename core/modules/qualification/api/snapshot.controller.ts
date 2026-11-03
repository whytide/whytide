// GET …/qualification/leads/{personId}/snapshot (README.md "Routes"), inside the request's tenant
// run: the lead's current snapshot, under the permission of contacts' lead routes, leads.read, which
// contacts declares and the lead page holds already.
import { Controller, Get, Param, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors, permissions } from "@whytide/contacts";
import { getSnapshot } from "../domain/score/get-snapshot.ts";
import { errors } from "../errors.ts";
import { type SnapshotResponse, snapshotParams, snapshotResponse } from "../schemas/snapshot.ts";

@Controller("leads")
export class SnapshotController {
  @Get(":personId/snapshot")
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The lead's current snapshot: the six verdicts with evidence, weight and points, the disqualifiers and the model's summary",
    params: snapshotParams,
    response: snapshotResponse,
    errors: [errors.score_snapshot_not_found, contactsErrors.lead_not_found],
  })
  async get(@Param("personId") personId: string): Promise<SnapshotResponse> {
    const { scoredAt, disqualifiers, verdicts, ...snapshot } = await getSnapshot(personId);
    return {
      ...snapshot,
      disqualifiers: [...disqualifiers],
      verdicts: verdicts.map((verdict) => ({ ...verdict })),
      scoredAt: scoredAt.toISOString(),
    };
  }
}
