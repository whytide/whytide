// GET …/contacts/persons and GET …/contacts/persons/{id} (README.md "Routes"): the api host mounts
// `api` (module.ts) under /v1/workspaces/:workspaceId/contacts and runs each handler inside the
// request's tenant run, where the commands read through tenantClient (core/apps/api/README.md
// "Modules").
import { Controller, Get, Param, Query, SetMetadata } from "@nestjs/common";
import { getPerson, listPersons, type Person } from "../domain/persons.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ListQuery,
  listQuery,
  type PersonPage,
  type PersonResponse,
  personPage,
  personParams,
  personResponse,
} from "../schemas/persons.ts";

@Controller("persons")
export class PersonsController {
  @Get()
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["contacts.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's people, newest first, a page at a time",
    query: listQuery,
    response: personPage,
  })
  async list(@Query() query: ListQuery): Promise<PersonPage> {
    const { persons, nextCursor } = await listPersons(query);
    return { persons: persons.map(toPersonResponse), nextCursor };
  }

  @Get(":id")
  @SetMetadata("whytide:permission", permissions["contacts.read"])
  @SetMetadata("whytide:api-route", {
    summary: "One person of the workspace: business fields and the provenance of each",
    params: personParams,
    response: personResponse,
    errors: [errors.person_not_found],
  })
  async get(@Param("id") id: string): Promise<PersonResponse> {
    return toPersonResponse(await getPerson(id));
  }
}

/** The person as the routes answer it, the lead routes too: no workspace, no provider's id. */
export function toPersonResponse(person: Person): PersonResponse {
  const { providerRefs: _refs, ...provenance } = person.fieldProvenance;
  return {
    id: person.id,
    linkedinUrl: person.linkedinUrl,
    firstName: person.firstName,
    lastName: person.lastName,
    headline: person.headline,
    title: person.title,
    companyName: person.companyName,
    companyId: person.companyId,
    locationText: person.locationText,
    locationCountry: person.locationCountry,
    provenance,
    createdAt: person.createdAt.toISOString(),
    updatedAt: person.updatedAt.toISOString(),
  };
}
