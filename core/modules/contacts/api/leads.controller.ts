// GET …/contacts/leads, …/contacts/leads/counts, …/contacts/leads/{personId} and its neighbours
// (README.md "Routes"), inside the request's tenant run like the person routes (persons.controller.ts):
// the lead with its person's fields; the counts route comes before {personId}, which would take its
// path.
import { Controller, Get, Param, Query, SetMetadata } from "@nestjs/common";
import { countLeads, getLead, type Lead, leadNeighbours, listLeads } from "../domain/leads.ts";
import { latestOf } from "../domain/review/reviews.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type LeadCounts,
  type LeadListQuery,
  type LeadNeighbours,
  type LeadPage,
  type LeadResponse,
  leadCounts,
  leadListQuery,
  leadNeighbours as leadNeighboursAnswer,
  leadPage,
  leadParams,
  leadResponse,
  type NeighboursQuery,
  neighboursQuery,
} from "../schemas/leads.ts";
import { toPersonResponse } from "./persons.controller.ts";

@Controller("leads")
export class LeadsController {
  @Get()
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's leads with their persons, by fit, newest or unreviewed first, paged",
    query: leadListQuery,
    response: leadPage,
    errors: [errors.contacts_input_invalid],
  })
  async list(@Query() query: LeadListQuery): Promise<LeadPage> {
    const { leads, nextCursor } = await listLeads(query);
    // The review column's hover: the reason of each Not a fit on the page, in one query.
    const notAFit = leads.filter((lead) => lead.reviewStatus === "not_a_fit");
    const latest = await latestOf(notAFit.map((lead) => lead.personId));
    const page = leads.map(({ person, ...lead }) => {
      const { firstName, lastName, title, companyName, linkedinUrl } = person;
      const review = lead.reviewStatus === "not_a_fit" ? latest.get(lead.personId) : undefined;
      const reviewReasonCode =
        review?.decision === "not_a_fit" ? (review.reasonCode ?? null) : null;
      return {
        ...answer(lead),
        reviewReasonCode,
        person: { firstName, lastName, title, companyName, linkedinUrl },
      };
    });
    return { leads: page, nextCursor };
  }

  @Get("counts")
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary: "How many of the workspace's leads are in each status, every status named",
    response: leadCounts,
  })
  async counts(): Promise<LeadCounts> {
    return { counts: await countLeads() };
  }

  @Get(":personId")
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary: "One lead: its fields, and the person's business fields with the provenance of each",
    params: leadParams,
    response: leadResponse,
    errors: [errors.lead_not_found],
  })
  async get(@Param("personId") personId: string): Promise<LeadResponse> {
    const { person, ...lead } = await getLead(personId);
    return { ...answer(lead), person: toPersonResponse(person) };
  }

  @Get(":personId/neighbours")
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The leads just before and just after this one in the list's view: its sort and filters",
    params: leadParams,
    query: neighboursQuery,
    response: leadNeighboursAnswer,
    errors: [errors.lead_not_found],
  })
  async neighbours(
    @Param("personId") personId: string,
    @Query() query: NeighboursQuery,
  ): Promise<LeadNeighbours> {
    return leadNeighbours({ personId, ...query });
  }
}

/** The lead as the routes answer it: no workspace. */
function answer(lead: Lead): Omit<LeadResponse, "person"> {
  const { workspaceId: _workspace, firstSourceAt, createdAt, updatedAt, ...fields } = lead;
  return {
    ...fields,
    sources: [...fields.sources],
    why: [...fields.why],
    firstSourceAt: firstSourceAt.toISOString(),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    reviewedAt: fields.reviewedAt?.toISOString() ?? null,
  };
}
