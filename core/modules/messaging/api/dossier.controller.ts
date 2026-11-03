// GET …/messaging/leads/{personId}/dossier (README.md "Route"): the lead's dossier, for the lead
// page's debug view and the grounding sample, under drafts.read. The route opens its own run
// (whytide:own-runs): the sender's name is tenancy's read of its global tables, which runs outside
// any run (domain/dossier/build.ts).
import type { IncomingMessage } from "node:http";
import { Controller, Get, Param, Req, SetMetadata } from "@nestjs/common";
import type { TenantContext } from "@whytide/platform";
import { buildDossier } from "../domain/dossier/build.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import { type Dossier, dossierParams, dossierSchema } from "../schemas/dossier.ts";

/** The request of a whytide:own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("leads")
export class DossierController {
  @Get(":personId/dossier")
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["drafts.read"])
  @SetMetadata("whytide:own-runs", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "The lead's dossier: the sender, offer, lead, company and why-now blocks, every value a fact with its id and source, the entities and the hash",
    params: dossierParams,
    response: dossierSchema,
    errors: [errors.dossier_lead_not_found],
  })
  async dossier(@Param("personId") personId: string, @Req() req: OwnRunsRequest): Promise<Dossier> {
    const { tenant } = req;
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (tenant === undefined) throw new Error("no tenant on an own-runs route");
    return buildDossier(tenant, personId);
  }
}
