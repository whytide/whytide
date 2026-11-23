// The lead page's routes (README "The lead page"; gamma-en-055), which the api host mounts under
// /v1/workspaces/:workspaceId/enrichment: thin handlers over domain/lead/read.ts, inside the
// request's tenant run. GET leads/:personId answers the person's company facts and country, each
// with its source class and time, never a provider's name (RB-7.3.2), and the last run, under
// enrichment.read. POST leads/:personId asks for a run, under enrichment.run, with an
// Idempotency-Key, which is the run's request key too: the same key answers the same run, whenever
// it comes again. A module cannot import the host, so each route sets the host's metadata itself:
// its permission, the key and its @ApiRoute.
import { Controller, Get, Headers, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import { leadEnrichment, requestLeadRun } from "../domain/lead/read.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type LeadEnrichmentResponse,
  type LeadRunResponse,
  leadEnrichmentResponse,
  leadParams,
  leadRunResponse,
} from "../schemas/lead.ts";

const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const idempotent = SetMetadata("whytide:idempotent", true);
/** The host's header, which its interceptor requires and checks before the handler runs. */
const KEY_HEADER = "idempotency-key";

@Controller("leads")
export class EnrichmentController {
  @Get(":personId")
  @SetMetadata("whytide:permission", permissions["enrichment.read"])
  @route({
    summary:
      "The person's company facts and country, each with its source class and when, an empty one null; and the person's last enrichment run",
    params: leadParams,
    response: leadEnrichmentResponse,
    errors: [errors.enrichment_person_not_found],
  })
  async read(@Param("personId") personId: string): Promise<LeadEnrichmentResponse> {
    const { company, person, lastRun } = await leadEnrichment(personId);
    const finishedAt = lastRun?.finishedAt?.toISOString() ?? null;
    return {
      company: company && { name: company.name, fields: [...company.fields] },
      person,
      lastRun: lastRun && {
        ...lastRun,
        filled: [...lastRun.filled],
        outcomes: [...lastRun.outcomes],
        finishedAt,
      },
    };
  }

  @Post(":personId")
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["enrichment.run"])
  @idempotent
  @route({
    summary:
      "Asks for an enrichment run of the person now, free: 202 with the run and its status; the same Idempotency-Key answers the same run",
    params: leadParams,
    response: leadRunResponse,
    errors: [errors.enrichment_person_not_found],
  })
  async request(
    @Param("personId") personId: string,
    @Headers(KEY_HEADER) key: string,
  ): Promise<LeadRunResponse> {
    return requestLeadRun(personId, key.toLowerCase());
  }
}
