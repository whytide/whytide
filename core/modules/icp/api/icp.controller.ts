// The ICP's routes (README "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/icp: each handler runs in the request's tenant run, so the commands
// read and write through its transaction. The ICP's own routes and the draft's without an icpId act
// on the workspace's default audience; `audiences/…` on the audience the path names. A module cannot
// import the host: a route writes the host's metadata itself, its permission, its idempotency and
// its @ApiRoute (core/apps/api/README.md "Modules", "Permissions", "Request protection", "OpenAPI
// and the client"). The audiences' list answers the limit settings.ts reads, for the screen; a
// summary names no configured value, so that the document never depends on the environment.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Put,
  Query,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import {
  type AudienceSummary,
  createAudience,
  creatorOf,
  getCriteria,
  getIcp,
  type Icp,
  listAudiences,
  saveCriteria,
  saveIcp,
} from "../domain/commands.ts";
import { AUDIENCES_PER_WORKSPACE } from "../domain/constants.ts";
import {
  acceptDraft,
  type DraftView,
  discardDraft,
  requestDraft,
  viewDraft,
} from "../domain/draft.ts";
import { draftErrors, errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type AcceptDraftBody,
  type AudienceBody,
  type AudienceResponse,
  type AudiencesResponse,
  acceptDraftBody,
  audienceBody,
  audienceParams,
  audienceResponse,
  audiencesResponse,
  type CriteriaBody,
  type CriteriaResponse,
  criteriaBody,
  criteriaResponse,
  type DraftBody,
  type DraftQuery,
  type DraftResponse,
  draftBody,
  draftQuery,
  draftResponse,
  type IcpBody,
  type IcpResponse,
  icpBody,
  icpResponse,
} from "../schemas/icp.ts";
import { settings } from "../settings.ts";

/** The codes of a value off a closed list (domain/rules.ts). */
const listErrors = [
  errors.icp_unknown_seniority,
  errors.icp_unknown_size_range,
  errors.icp_unknown_country,
];

@Controller()
export class IcpController {
  @Get()
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's ICP; the first read creates it empty, with its six criteria",
    response: icpResponse,
  })
  async readIcp(): Promise<IcpResponse> {
    return answer(await getIcp(currentTenant().workspaceId));
  }

  @Put()
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the ICP; a targeting change moves its version and publishes icp.updated",
    body: icpBody,
    response: icpResponse,
    errors: listErrors,
  })
  async writeIcp(@Body() body: IcpBody): Promise<IcpResponse> {
    return answer(await saveIcp(body));
  }

  @Get("criteria")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The ICP's six criteria with their weights, must flags and enabled flags",
    response: criteriaResponse,
  })
  async readCriteria(): Promise<CriteriaResponse> {
    return { criteria: await getCriteria(currentTenant().workspaceId) };
  }

  @Put("criteria")
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the six criteria; their weights sum to 100",
    body: criteriaBody,
    response: criteriaResponse,
    errors: [errors.icp_weights_must_sum_100],
  })
  async writeCriteria(@Body() body: CriteriaBody): Promise<CriteriaResponse> {
    return { criteria: await saveCriteria(body.criteria) };
  }

  @Get("audiences")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The workspace's audiences, the default first, then by name, and the limit on audiences; the first read makes the default",
    response: audiencesResponse,
  })
  async readAudiences(): Promise<AudiencesResponse> {
    const audiences = (await listAudiences()).map(audienceAnswer);
    return { audiences, limits: { audiences: settings.ICP_MAX_AUDIENCES_PER_WORKSPACE } };
  }

  @Post("audiences")
  @HttpCode(201)
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: `A new audience with the six default criteria, made by the caller; the list's limits.audiences at most in a workspace, the default included, ${AUDIENCES_PER_WORKSPACE.default} by default`,
    body: audienceBody,
    response: audienceResponse,
    errors: [errors.icp_audience_limit],
  })
  async addAudience(@Body() body: AudienceBody): Promise<AudienceResponse> {
    const createdBy = creatorOf(currentTenant().principal);
    return audienceAnswer(await createAudience({ name: body.name, createdBy }));
  }

  @Get("audiences/:icpId")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The audience, as GET …/icp answers the default",
    params: audienceParams,
    response: icpResponse,
    errors: [errors.icp_not_found],
  })
  async readAudience(@Param("icpId") icpId: string): Promise<IcpResponse> {
    return answer(await getIcp(currentTenant().workspaceId, icpId));
  }

  @Put("audiences/:icpId")
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary:
      "Saves the audience as PUT …/icp saves the default; a targeting change moves its version and publishes icp.audience_updated",
    params: audienceParams,
    body: icpBody,
    response: icpResponse,
    errors: [...listErrors, errors.icp_not_found],
  })
  async writeAudience(@Param("icpId") icpId: string, @Body() body: IcpBody): Promise<IcpResponse> {
    return answer(await saveIcp(body, icpId));
  }

  @Get("audiences/:icpId/criteria")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The audience's six criteria, as GET …/icp/criteria answers the default's",
    params: audienceParams,
    response: criteriaResponse,
    errors: [errors.icp_not_found],
  })
  async readAudienceCriteria(@Param("icpId") icpId: string): Promise<CriteriaResponse> {
    return { criteria: await getCriteria(currentTenant().workspaceId, icpId) };
  }

  @Put("audiences/:icpId/criteria")
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the audience's six criteria; their weights sum to 100",
    params: audienceParams,
    body: criteriaBody,
    response: criteriaResponse,
    errors: [errors.icp_weights_must_sum_100, errors.icp_not_found],
  })
  async writeAudienceCriteria(
    @Param("icpId") icpId: string,
    @Body() body: CriteriaBody,
  ): Promise<CriteriaResponse> {
    return { criteria: await saveCriteria(body.criteria, icpId) };
  }

  @Get("draft")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The audience's latest draft, and whether Company Knowledge has a field to draft from",
    query: draftQuery,
    response: draftResponse,
    errors: [errors.icp_not_found],
  })
  async readDraft(@Query() query: DraftQuery): Promise<DraftResponse> {
    return draftAnswer(await viewDraft(currentTenant().workspaceId, query.icpId));
  }

  @Post("draft")
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "Drafts the audience from Company Knowledge and the brief: drafting, and the worker drafts",
    query: draftQuery,
    body: draftBody,
    response: draftResponse,
    errors: [
      draftErrors.icp_draft_brief_too_long,
      draftErrors.icp_draft_no_source,
      errors.icp_not_found,
    ],
  })
  async draft(@Query() query: DraftQuery, @Body() body: DraftBody): Promise<DraftResponse> {
    const { workspaceId } = currentTenant();
    await requestDraft(workspaceId, body.brief ?? "", query.icpId);
    return draftAnswer(await viewDraft(workspaceId, query.icpId));
  }

  @Post("draft/accept")
  @HttpCode(200)
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary:
      "Saves the run's drafted name and targeting as a PUT does, the criteria kept; the draft ends",
    query: draftQuery,
    body: acceptDraftBody,
    response: icpResponse,
    errors: [
      draftErrors.icp_draft_none,
      draftErrors.icp_not_empty,
      draftErrors.icp_draft_invalid,
      errors.icp_not_found,
    ],
  })
  async accept(@Query() query: DraftQuery, @Body() body: AcceptDraftBody): Promise<IcpResponse> {
    return answer(await acceptDraft(body.replace ?? false, body.runId, query.icpId));
  }

  @Post("draft/discard")
  @HttpCode(200)
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary: "Discards the drafted proposal; the audience keeps every field",
    query: draftQuery,
    response: draftResponse,
    errors: [draftErrors.icp_draft_none, errors.icp_not_found],
  })
  async discard(@Query() query: DraftQuery): Promise<DraftResponse> {
    await discardDraft(query.icpId);
    return draftAnswer(await viewDraft(currentTenant().workspaceId, query.icpId));
  }
}

@Module({ controllers: [IcpController] })
export class IcpApi {}

function answer(icp: Icp): IcpResponse {
  return { ...icp, updatedAt: icp.updatedAt.toISOString() };
}

function audienceAnswer(audience: AudienceSummary): AudienceResponse {
  return { ...audience, updatedAt: audience.updatedAt.toISOString() };
}

/**
 * The draft as the routes answer it: the proposal's fields, prompt version and run, nothing else of
 * it. Only the latest run writes a proposal (recordDraft), so a proposal always has its run.
 */
function draftAnswer(view: DraftView): DraftResponse {
  const { status, error, draftRunId: runId, pending, hasKnowledge } = view;
  const proposal =
    pending && runId !== null
      ? { fields: pending.fields, promptVersion: pending.promptVersion, runId }
      : null;
  return { status, error, pending: proposal, hasKnowledge };
}
