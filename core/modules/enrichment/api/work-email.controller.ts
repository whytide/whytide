// The Email panel's routes (README "The Email panel"; gamma-en-081; the phones' route, gamma-wr-100: GET
// leads/:personId/phones, the numbers a page printed with the person and their pages), which the api host mounts under
// /v1/workspaces/:workspaceId/enrichment: thin handlers over domain/lead/email.ts, inside the
// request's tenant run. GET leads/:personId/work-email answers the person's held address and the last
// lookup, never a finder's or verifier's name (RB-7.3.2), under enrichment.read. POST asks for a
// lookup ("find", priced at enrichment.work_email, paid only for a verified address) or for the held
// address checked again ("verify", free), under enrichment.run, with an Idempotency-Key, which is the
// request's key too: the same key answers the same request. A module cannot import the host, so each
// route sets the host's metadata itself: its permission, the key and its @ApiRoute.
import { Body, Controller, Get, Headers, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import { leadEmail, requestLeadEmail } from "../domain/lead/email.ts";
import { leadPhones } from "../domain/lead/phones.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type EmailRequestBody,
  type EmailRequestResponse,
  emailRequestBody,
  emailRequestResponse,
  type LeadEmailResponse,
  type LeadPhonesResponse,
  leadEmailResponse,
  leadPhonesResponse,
} from "../schemas/email.ts";
import { leadParams } from "../schemas/lead.ts";

const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const idempotent = SetMetadata("whytide:idempotent", true);
/** The host's header, which its interceptor requires and checks before the handler runs. */
const KEY_HEADER = "idempotency-key";

@Controller("leads")
export class WorkEmailController {
  @Get(":personId/work-email")
  @SetMetadata("whytide:permission", permissions["enrichment.read"])
  @route({
    summary:
      "The person's held address with its kind, verification, source class and times, and their last email lookup with its status and reason",
    params: leadParams,
    response: leadEmailResponse,
    errors: [errors.enrichment_person_not_found],
  })
  async read(@Param("personId") personId: string): Promise<LeadEmailResponse> {
    const { email, lastLookup } = await leadEmail(personId);
    return {
      email: email && {
        ...email,
        verifiedAt: email.verifiedAt.toISOString(),
        acquiredAt: email.acquiredAt.toISOString(),
      },
      lastLookup: lastLookup && {
        ...lastLookup,
        finishedAt: lastLookup.finishedAt?.toISOString() ?? null,
      },
    };
  }

  @Get(":personId/phones")
  @SetMetadata("whytide:permission", permissions["enrichment.read"])
  @route({
    summary:
      "The numbers a public page printed with the person, each with the page that printed it; never a provider's name",
    params: leadParams,
    response: leadPhonesResponse,
    errors: [errors.enrichment_person_not_found],
  })
  async phones(@Param("personId") personId: string): Promise<LeadPhonesResponse> {
    const { phones } = await leadPhones(personId);
    return {
      phones: phones.map(({ number, page, acquiredAt }) => ({
        ...{ number, page },
        acquiredAt: acquiredAt.toISOString(),
      })),
    };
  }

  @Post(":personId/work-email")
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["enrichment.run"])
  @idempotent
  @route({
    summary:
      "Asks for the person's email: find, a lookup charged only for a verified address; verify, the held address checked again, free. 202 with the request and its status; the same Idempotency-Key answers the same request",
    params: leadParams,
    body: emailRequestBody,
    response: emailRequestResponse,
    errors: [errors.enrichment_person_not_found],
  })
  async request(
    @Param("personId") personId: string,
    @Headers(KEY_HEADER) key: string,
    @Body() { action }: EmailRequestBody,
  ): Promise<EmailRequestResponse> {
    return requestLeadEmail(personId, key.toLowerCase(), action);
  }
}
