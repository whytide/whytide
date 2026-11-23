// The agents' routes (README "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/playbooks: thin handlers over domain/playbooks.ts, each in the
// request's tenant run, so the commands read and write through its transaction. A module cannot
// import the host: a route writes the host's metadata itself, its permission, its idempotency and
// its @ApiRoute (core/apps/api/README.md "Modules", "Permissions", "Request protection", "OpenAPI
// and the client"). The list answers the limits settings.ts reads, for the screens; a summary names
// no configured value, so that the document never depends on the environment.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  SetMetadata,
} from "@nestjs/common";
import { AppError, currentTenant } from "@whytide/platform";
import { AGENTS_PER_WORKSPACE, SOURCES_PER_AGENT } from "../domain/constants.ts";
import {
  checkSources,
  createPlaybook,
  getPlaybook,
  listPlaybooks,
  type Playbook,
  setSources,
  sourcesOf,
  updatePlaybook,
} from "../domain/playbooks.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CheckQuery,
  type CheckResponse,
  type CreatePlaybookBody,
  checkQuery,
  checkResponse,
  createPlaybookBody,
  type PlaybookListResponse,
  type PlaybookResponse,
  playbookListResponse,
  playbookParams,
  playbookResponse,
  type SourcesBody,
  sourcesBody,
  type UpdatePlaybookBody,
  updatePlaybookBody,
} from "../schemas/playbooks.ts";
import { settings } from "../settings.ts";

const read = SetMetadata("whytide:permission", permissions["playbooks.read"]);
const write = SetMetadata("whytide:permission", permissions["playbooks.write"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

/** A source's refusals, and the refusal without a checker. */
const sourceErrors = [
  errors.playbook_source_not_found,
  errors.playbook_source_wrong_owner,
  errors.playbook_source_in_use,
  errors.playbook_source_checker_missing,
];

@Controller()
export class PlaybooksController {
  @Get()
  @read
  @route({
    summary:
      "The workspace's agents with their sources' counts, the live ones first, and the limits on agents and sources",
    response: playbookListResponse,
  })
  async list(): Promise<PlaybookListResponse> {
    const playbooks = await listPlaybooks();
    return {
      playbooks: playbooks.map((playbook) => ({
        ...answer(playbook),
        sourceCount: playbook.sourceCount,
      })),
      limits: {
        agents: settings.PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE,
        sources: settings.PLAYBOOKS_MAX_SOURCES_PER_AGENT,
      },
    };
  }

  @Post()
  @HttpCode(201)
  @write
  @idempotent
  @route({
    summary: `A new agent on an audience no live agent has, owned by the caller, active; the list's limits.agents live at most in a workspace, ${AGENTS_PER_WORKSPACE.default} by default; publishes playbooks.playbook_created`,
    body: createPlaybookBody,
    response: playbookResponse,
    errors: [
      errors.playbook_icp_not_found,
      errors.playbook_icp_in_use,
      errors.playbook_limit_reached,
    ],
  })
  async create(@Body() body: CreatePlaybookBody): Promise<PlaybookResponse> {
    const ownerUserId = currentTenant().principal.userId;
    const created = await createPlaybook({ name: body.name, icpId: body.icpId, ownerUserId });
    return { ...answer(created), sourceIds: [] };
  }

  @Get(":playbookId")
  @read
  @route({
    summary: "The agent and the ids of its sources",
    params: playbookParams,
    response: playbookResponse,
    errors: [errors.playbook_not_found],
  })
  async get(@Param("playbookId") playbookId: string): Promise<PlaybookResponse> {
    return withSources(await getPlaybook(playbookId));
  }

  @Patch(":playbookId")
  @write
  @route({
    summary:
      "Renames the agent, moves it to another audience or changes its status; archived is final and frees its sources and its audience; an agent paused because its owner left is resumed by that owner alone; publishes playbooks.playbook_updated",
    params: playbookParams,
    body: updatePlaybookBody,
    response: playbookResponse,
    errors: [
      errors.playbook_not_found,
      errors.playbook_archived,
      errors.playbook_owner_removed,
      errors.playbook_icp_not_found,
      errors.playbook_icp_in_use,
    ],
  })
  async update(
    @Param("playbookId") playbookId: string,
    @Body() body: UpdatePlaybookBody,
  ): Promise<PlaybookResponse> {
    return withSources(await updatePlaybook(playbookId, body));
  }

  @Put(":playbookId/sources")
  @write
  @route({
    summary: `Replaces the agent's sources, the list's limits.sources at most, ${SOURCES_PER_AGENT.default} by default, each checked through the source checker signals registers; with none registered, 503 and nothing written; publishes playbooks.sources_changed`,
    params: playbookParams,
    body: sourcesBody,
    response: playbookResponse,
    errors: [
      errors.playbook_not_found,
      errors.playbook_archived,
      errors.playbook_sources_limit,
      ...sourceErrors,
    ],
  })
  async sources(
    @Param("playbookId") playbookId: string,
    @Body() body: SourcesBody,
  ): Promise<PlaybookResponse> {
    await setSources(playbookId, body.sourceIds);
    return withSources(await getPlaybook(playbookId));
  }

  @Get(":playbookId/sources/check")
  @read
  @route({
    summary:
      "Whether the agent may hold each source, and the code PUT …/sources would answer: found, read through the owner's own account, held by no other agent",
    params: playbookParams,
    query: checkQuery,
    response: checkResponse,
    errors: [errors.playbook_not_found, errors.playbook_source_checker_missing],
  })
  async check(
    @Param("playbookId") playbookId: string,
    @Query() query: CheckQuery,
  ): Promise<CheckResponse> {
    const ids = query.ids ? query.ids.split(",") : [];
    return { sources: await checkSources(playbookId, ids) };
  }
}

@Module({ controllers: [PlaybooksController] })
export class PlaybooksApi {}

function answer(playbook: Playbook) {
  const { id, name, icpId, ownerUserId, status, pausedReason, createdAt } = playbook;
  const fields = { id, name, icpId, ownerUserId, status, pausedReason };
  return { ...fields, createdAt: createdAt.toISOString() };
}

/** The agent as GET answers it, with its sources; null is playbook_not_found. */
async function withSources(playbook: Playbook | null): Promise<PlaybookResponse> {
  if (playbook === null) throw new AppError(errors.playbook_not_found);
  return { ...answer(playbook), sourceIds: await sourcesOf(playbook.id) };
}
