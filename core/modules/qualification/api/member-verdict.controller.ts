// PUT and DELETE …/qualification/leads/{personId}/verdicts/{criterion} (README.md "A member's
// verdict", "Routes"), inside the request's tenant run: a member sets or clears the verdict of one
// criterion of the lead's current snapshot, under contacts' reviews.write, a review decision's
// permission, which every role holds. Each answers the snapshot read again, with the new decision.
import { Body, Controller, Delete, Param, Put, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors, permissions } from "@whytide/contacts";
import { clearMemberVerdict, setMemberVerdict } from "../domain/member-verdict.ts";
import { errors } from "../errors.ts";
import {
  type MemberVerdictBody,
  memberVerdictBody,
  memberVerdictParams,
} from "../schemas/member-verdict.ts";
import { type SnapshotResponse, snapshotResponse } from "../schemas/snapshot.ts";
import { snapshotAnswer } from "./snapshot.controller.ts";

const refusals = [
  errors.qualification_input_invalid,
  errors.score_snapshot_not_found,
  contactsErrors.lead_not_found,
];

@Controller("leads")
export class MemberVerdictController {
  @Put(":personId/verdicts/:criterion")
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["reviews.write"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Sets a member's verdict, with an optional note, on one criterion of the lead's current snapshot, which counts instead of the model's; the lead is decided again",
    params: memberVerdictParams,
    body: memberVerdictBody,
    response: snapshotResponse,
    errors: refusals,
  })
  async set(
    @Param("personId") personId: string,
    @Param("criterion") criterion: string,
    @Body() body: MemberVerdictBody,
  ): Promise<SnapshotResponse> {
    return snapshotAnswer(await setMemberVerdict(personId, criterion, body));
  }

  @Delete(":personId/verdicts/:criterion")
  @SetMetadata("whytide:permission", permissions["reviews.write"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Clears a member's verdict on one criterion of the lead's current snapshot: the model's counts again, and the lead is decided again",
    params: memberVerdictParams,
    response: snapshotResponse,
    errors: refusals,
  })
  async clear(
    @Param("personId") personId: string,
    @Param("criterion") criterion: string,
  ): Promise<SnapshotResponse> {
    return snapshotAnswer(await clearMemberVerdict(personId, criterion));
  }
}
