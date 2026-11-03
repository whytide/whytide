// The draft routes (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/messaging: thin handlers over domain/drafts/store.ts, inside the
// request's tenant run; the worker writes a requested draft (README.md "The workflow"). A module
// cannot import the host, so each route sets the host's metadata itself: its permission and its
// @ApiRoute (core/apps/api/README.md "Permissions", "OpenAPI and the client").
import { Body, Controller, Get, HttpCode, Param, Patch, Post, SetMetadata } from "@nestjs/common";
import {
  type Draft,
  editDraft,
  getDraft,
  listDrafts,
  regenerateDraft,
  requestDraft,
} from "../domain/drafts/store.ts";
import { hardLimitOf } from "../domain/gates/index.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CreateDraftBody,
  createDraftBody,
  type DraftResponse,
  draftListResponse,
  draftParams,
  draftResponse,
  type EditDraftBody,
  editDraftBody,
  leadParams,
} from "../schemas/drafts.ts";

const read = SetMetadata("whytide:permission", permissions["drafts.read"]);
const write = SetMetadata("whytide:permission", permissions["drafts.write"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller()
export class DraftsController {
  @Post("leads/:personId/drafts")
  @HttpCode(202)
  @write
  @idempotent
  @route({
    summary:
      "Asks for a draft of the lead on the channel: 202 with the draft, drafting; publishes messaging.draft_requested, from which the worker writes it",
    params: leadParams,
    body: createDraftBody,
    response: draftResponse,
    errors: [errors.dossier_lead_not_found],
  })
  async create(
    @Param("personId") personId: string,
    @Body() body: CreateDraftBody,
  ): Promise<DraftResponse> {
    return toResponse(await requestDraft({ personId, channel: body.channel }));
  }

  @Get("leads/:personId/drafts")
  @read
  @route({
    summary: "The lead's drafts, newest first; a sequence step's draft is never listed here",
    params: leadParams,
    response: draftListResponse,
  })
  async list(@Param("personId") personId: string): Promise<{ drafts: DraftResponse[] }> {
    return { drafts: (await listDrafts(personId)).map(toResponse) };
  }

  @Get("drafts/:id")
  @read
  @route({
    summary: "A draft: its status, plan, text and edit, generation record and gate results",
    params: draftParams,
    response: draftResponse,
    errors: [errors.draft_not_found],
  })
  async get(@Param("id") id: string): Promise<DraftResponse> {
    return toResponse(await getDraft(id));
  }

  @Patch("drafts/:id")
  @write
  @route({
    summary:
      "Saves the member's own text, at most the channel's limit and passing the gates (no placeholder, red line or colleague's signal): the draft becomes edited, which no later write changes; a sequence step's draft is refused",
    params: draftParams,
    body: editDraftBody,
    response: draftResponse,
    errors: [
      errors.draft_not_found,
      errors.draft_not_editable,
      errors.step_draft_not_editable,
      errors.messaging_input_invalid,
      errors.draft_text_refused,
    ],
  })
  async edit(@Param("id") id: string, @Body() body: EditDraftBody): Promise<DraftResponse> {
    return toResponse(await editDraft(id, body));
  }

  @Post("drafts/:id/regenerate")
  @HttpCode(202)
  @write
  @idempotent
  @route({
    summary:
      "Asks for a new draft of the same lead and channel, unlike this one, which is kept: 202 with the new draft, drafting; publishes messaging.draft_requested; a sequence step's draft is refused",
    params: draftParams,
    response: draftResponse,
    errors: [
      errors.draft_not_found,
      errors.draft_not_editable,
      errors.step_draft_not_editable,
      errors.dossier_lead_not_found,
    ],
  })
  async regenerate(@Param("id") id: string): Promise<DraftResponse> {
    return toResponse(await regenerateDraft(id));
  }
}

/**
 * The answer: the stored plan without its decision record, the times as ISO strings, and the
 * channel's limit now, which an edit is held to (hardLimitOf).
 */
function toResponse(draft: Draft): DraftResponse {
  const { id, personId, channel, kind, status, text, editedText, modelId, promptVersion } = draft;
  const { dossierHash, regenerations, editedAt, createdAt, updatedAt } = draft;
  const plan = draft.plan as DraftResponse["plan"];
  return {
    ...{ id, personId, channel, kind, status, text, editedText, modelId, promptVersion },
    dossierHash,
    plan: plan && { angle: plan.angle, factIds: plan.factIds, cta: plan.cta },
    gates: draft.gates as DraftResponse["gates"],
    regenerations,
    flagReasons: draft.flagReasons as DraftResponse["flagReasons"],
    maxCharacters: hardLimitOf(channel),
    editedAt: editedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}
