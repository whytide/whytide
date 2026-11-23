// GET and POST …/contacts/suppression and DELETE …/contacts/suppression/{id} (README.md "Routes"):
// the never-contact list, inside the request's tenant run like the other routes
// (persons.controller.ts). The adds and removals are the principal's: created_by and removed_by. An
// add declares suppression.write, every role's; the DELETE, which lifts an exclusion,
// suppression.remove, Owner's and Admin's (permissions.ts).
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import {
  addSuppression,
  describeEntries,
  type ListedEntry,
  listSuppression,
  removeSuppression,
} from "../domain/suppression/entries.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type SuppressionBody,
  type SuppressionEntryResponse,
  type SuppressionPage,
  type SuppressionQuery,
  suppressionBody,
  suppressionEntry,
  suppressionPage,
  suppressionParams,
  suppressionQuery,
} from "../schemas/suppression.ts";

const read = SetMetadata("whytide:permission", permissions["suppression.read"]);
const write = SetMetadata("whytide:permission", permissions["suppression.write"]);
const remove = SetMetadata("whytide:permission", permissions["suppression.remove"]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller("suppression")
export class SuppressionController {
  @Get()
  @read
  @route({
    summary:
      "The workspace's active never-contact entries and opt-outs, newest first, a page at a time, each with the person or company it names",
    query: suppressionQuery,
    response: suppressionPage,
  })
  async list(@Query() query: SuppressionQuery): Promise<SuppressionPage> {
    const { entries, nextCursor } = await listSuppression(query);
    return { entries: entries.map(toEntry), nextCursor };
  }

  @Post()
  @write
  @SetMetadata("whytide:idempotent", true)
  @route({
    summary:
      "Adds a person (by id, profile or email address) or a company to the never-contact list, on every channel or on one, a company as a customer or a competitor by its domain, or a person's opt-out by hand, always on every channel; an active entry with the same key is answered unchanged; publishes contacts.suppression_added for a new one",
    body: suppressionBody,
    response: suppressionEntry,
    errors: [
      errors.suppression_target_invalid,
      errors.contacts_input_invalid,
      errors.person_not_found,
      errors.company_not_found,
    ],
  })
  async add(@Body() body: SuppressionBody): Promise<SuppressionEntryResponse> {
    const { entry } = await addSuppression({
      ...body,
      createdBy: currentTenant().principal.userId,
    });
    const [listed] = await describeEntries([entry]);
    return toEntry(listed as ListedEntry);
  }

  @Delete(":id")
  @HttpCode(204)
  @remove
  @route({
    summary:
      "Lifts an exclusion: removes a never-contact or relationship entry, which stays on record with its removal; an opt-out is never removed",
    params: suppressionParams,
    errors: [errors.suppression_not_found, errors.suppression_not_removable],
  })
  async remove(@Param("id") id: string): Promise<void> {
    await removeSuppression(id, { removedBy: currentTenant().principal.userId });
  }
}

/** An entry as the routes answer it: no workspace, hash or removal. */
function toEntry(entry: ListedEntry): SuppressionEntryResponse {
  const { id, layer, matchType, linkedinUrl, domain, email, channel, relationship } = entry;
  const { source, reason, createdBy, personId, companyId, displayName } = entry;
  const createdAt = entry.createdAt.toISOString();
  return {
    id,
    layer,
    matchType,
    linkedinUrl,
    domain,
    email,
    channel,
    relationship,
    source,
    reason,
    createdBy,
    createdAt,
    personId,
    companyId,
    displayName,
  };
}
