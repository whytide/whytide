// POST …/qualification/leads/{personId}/reassess (README "A new assessment", "Routes"), inside the
// request's tenant run: the lead page's Re-score, a member asking the AI to assess a decided lead
// again, under qualification.rescore, the criteria re-score's permission (Owner and Admin).
import { Controller, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors } from "@whytide/contacts";
import { requestReassess } from "../domain/member-reassess/index.ts";
import { permissions } from "../permissions.ts";
import { type ReassessResponse, reassessParams, reassessResponse } from "../schemas/reassess.ts";

@Controller("leads")
export class ReassessController {
  @Post(":personId/reassess")
  @HttpCode(202)
  // The api host's @Permission, @Idempotent and @ApiRoute, which a module cannot import.
  @SetMetadata("whytide:permission", permissions["qualification.rescore"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "Asks the AI to assess the decided lead again with its person's fields of now, for one assessment's credits: the lead waits as pending, member_requested, and the batch starts; a lead that waits already stays as it is",
    params: reassessParams,
    response: reassessResponse,
    errors: [contactsErrors.lead_not_found],
  })
  async reassess(@Param("personId") personId: string): Promise<ReassessResponse> {
    return requestReassess(personId);
  }
}
