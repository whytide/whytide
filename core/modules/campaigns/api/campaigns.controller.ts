// GET …/campaigns and GET …/campaigns/:campaignId (README.md "Routes"), which the api host mounts
// under /v1/workspaces/:workspaceId/campaigns: the workspace's campaigns, or with ?playbookId= the
// agent's (gamma-p3-065), and one with its current version's steps, read in the request's tenant
// run, so another workspace's never come. Each makes the seeded campaign first, on first use
// (domain/campaigns/commands.ts seedCampaign). POST …/campaigns/:campaignId/pause and …/resume
// (gamma-p3-060) pause an active campaign as a member's and resume it, under campaigns.write. PUT
// …/:campaignId/sequence saves the editor's list as the next version, PATCH renames the campaign,
// GET …/launch-checks reads its checks and POST …/launch moves a draft to active once they pass
// (gamma-p3-050), the writes under campaigns.write. PUT …/:campaignId/approval-mode sets the
// campaign's approval mode under campaigns.approval_mode (gamma-p4-070), in runs of its own
// (whytide:own-runs): one for the mode, then one per step the switch back takes the mode from; the
// campaign's GET answers its mode too, and the sequence's longest delay as configured (limits,
// settings.ts), which the editor shows; no summary names a configured value, so that the document
// never depends on the environment. A module cannot import the host, so each handler sets the
// host's metadata itself: its permission and its @ApiRoute, which checks the path and the body and
// documents the route (core/apps/api/README.md). module.ts registers this controller last, so the
// enrollments' and the counts' paths are never an id.
import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant, type TenantContext } from "@whytide/platform";
import { modeOf } from "../domain/approval-mode/mode.ts";
import { type ApprovalModeAnswer, changeApprovalMode } from "../domain/approval-mode/set.ts";
import { renameCampaign, saveVersion, seedCampaign } from "../domain/campaigns/commands.ts";
import { CAMPAIGN_NAME_MAX } from "../domain/campaigns/constants.ts";
import { editedSequence } from "../domain/campaigns/edit.ts";
import {
  type CampaignSummary,
  campaignOf,
  campaignsOf,
  versionOf,
} from "../domain/campaigns/reads.ts";
import type { VersionStep } from "../domain/campaigns/sequence.ts";
import { now } from "../domain/clock.ts";
import { launchCampaign, launchChecks } from "../domain/launch/launch.ts";
import { type CampaignPause, pauseCampaign, resumeCampaign } from "../domain/pause/campaign.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ApprovalModeBody,
  type ApprovalModeResponse,
  approvalModeBody,
  approvalModeResponse,
  type CampaignPauseResponse,
  type CampaignResponse,
  type CampaignsQuery,
  type CampaignsResponse,
  campaignParams,
  campaignPauseResponse,
  campaignResponse,
  campaignsQuery,
  campaignsResponse,
  type LaunchChecksResponse,
  type LaunchResponse,
  launchChecksResponse,
  launchResponse,
  type RenameBody,
  type RenameResponse,
  renameBody,
  renameResponse,
  type SequenceBody,
  type SequenceResponse,
  type StepResponse,
  sequenceBody,
  sequenceResponse,
} from "../schemas/campaigns.ts";
import { settings } from "../settings.ts";

const read = SetMetadata("whytide:permission", permissions["campaigns.read"]);
const write = SetMetadata("whytide:permission", permissions["campaigns.write"]);
const setMode = SetMetadata("whytide:permission", permissions["campaigns.approval_mode"]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const ownRuns = SetMetadata("whytide:own-runs", true);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller()
export class CampaignsController {
  @Get()
  @read
  @route({
    summary:
      "The workspace's campaigns, oldest first, or with playbookId the agent's alone, each with its current version's number and step count; the first read makes the seeded campaign",
    query: campaignsQuery,
    response: campaignsResponse,
  })
  async list(@Query() query: CampaignsQuery): Promise<CampaignsResponse> {
    await seedCampaign();
    return { campaigns: (await campaignsOf(query)).map(toResponse) };
  }

  @Get(":campaignId")
  @read
  @route({
    summary:
      "The campaign and its current version's steps by position, each with its key, action, channel and delay, and the limits the sequence editor shows",
    params: campaignParams,
    response: campaignResponse,
    errors: [errors.campaign_not_found],
  })
  async get(@Param("campaignId") campaignId: string): Promise<CampaignResponse> {
    await seedCampaign();
    const campaign = await campaignOf(campaignId);
    const { currentVersionId } = campaign;
    const version = currentVersionId === null ? null : await versionOf(campaign, currentVersionId);
    const steps = version?.steps ?? [];
    const summary = { ...campaign, versionNo: version?.versionNo ?? null, stepCount: steps.length };
    const approvalMode = modeResponse(modeOf(campaign, now()));
    const limits = { maxStepDelayBusinessDays: settings.CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS };
    return { ...toResponse(summary), steps: steps.map(stepResponse), approvalMode, limits };
  }

  @Put(":campaignId/approval-mode")
  @setMode
  @ownRuns
  @route({
    summary:
      "Sets the campaign's approval mode: review_everything, always taken, or review_first_touches once its first 7 days are over, whose follow-ups go with the mode's approval and the AI disclosure line; back to review_everything, every step the mode approved waits for a person again; the mode, the one in force now and the end of the lock",
    params: campaignParams,
    body: approvalModeBody,
    response: approvalModeResponse,
    errors: [
      errors.campaign_not_found,
      errors.approval_mode_locked,
      errors.approval_mode_unavailable,
    ],
  })
  async approvalMode(
    @Req() req: OwnRunsRequest,
    @Param("campaignId") campaignId: string,
    @Body() body: ApprovalModeBody,
  ): Promise<ApprovalModeResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    return modeResponse(await changeApprovalMode(req.tenant, campaignId, body.mode));
  }

  @Put(":campaignId/sequence")
  @write
  @route({
    summary:
      "Saves the editor's steps as the campaign's next version, which only new enrollments join, a delay in business days on each step but the connection request, the first message and, with the fallback, the first email; the same steps again write nothing; the version's number and steps",
    params: campaignParams,
    body: sequenceBody,
    response: sequenceResponse,
    errors: [errors.campaign_not_found, errors.campaign_sequence_invalid, errors.campaign_archived],
  })
  async saveSequence(
    @Param("campaignId") campaignId: string,
    @Body() body: SequenceBody,
  ): Promise<SequenceResponse> {
    const createdBy = currentTenant().principal.userId;
    const saved = await saveVersion(campaignId, editedSequence(body), { createdBy });
    const version = await versionOf(await campaignOf(campaignId), saved.id);
    return { versionNo: version.versionNo, steps: version.steps.map(stepResponse) };
  }

  @Patch(":campaignId")
  @write
  @route({
    summary: `Renames the campaign, its name trimmed, 1 to ${CAMPAIGN_NAME_MAX} characters; its id and name`,
    params: campaignParams,
    body: renameBody,
    response: renameResponse,
    errors: [errors.campaign_not_found, errors.campaign_name_invalid],
  })
  async rename(
    @Param("campaignId") campaignId: string,
    @Body() body: RenameBody,
  ): Promise<RenameResponse> {
    return renameCampaign(campaignId, body.name);
  }

  @Get(":campaignId/launch-checks")
  @read
  @route({
    summary:
      "The campaign's launch checks read now, for its owner: their LinkedIn account connected, not paused and healthy, its sending disclosure accepted, and credits for a send; each with its code when it fails",
    params: campaignParams,
    response: launchChecksResponse,
    errors: [errors.campaign_not_found],
  })
  async checks(@Param("campaignId") campaignId: string): Promise<LaunchChecksResponse> {
    return { checks: await launchChecks(campaignId) };
  }

  @Post(":campaignId/launch")
  @HttpCode(200)
  @write
  @route({
    summary:
      "Launches the draft campaign once every launch check passes again: active, with its launch time; a refusal names every check",
    params: campaignParams,
    response: launchResponse,
    errors: [errors.campaign_not_found, errors.campaign_not_draft, errors.campaign_launch_blocked],
  })
  async launch(@Param("campaignId") campaignId: string): Promise<LaunchResponse> {
    const launched = await launchCampaign(campaignId);
    return { ...launched, launchedAt: launched.launchedAt.toISOString() };
  }

  @Post(":campaignId/pause")
  @HttpCode(200)
  @write
  @route({
    summary:
      "Pauses the active campaign as a member's: no step of its enrollments is opened, placed or sent until it resumes; a draft is not paused; the campaign's status and pause",
    params: campaignParams,
    response: campaignPauseResponse,
    errors: [errors.campaign_not_found, errors.campaign_not_active],
  })
  async pause(@Param("campaignId") campaignId: string): Promise<CampaignPauseResponse> {
    return pauseResponse(await pauseCampaign(campaignId, { reason: "user" }));
  }

  @Post(":campaignId/resume")
  @HttpCode(200)
  @write
  @route({
    summary:
      "Resumes the paused campaign: its enrollments' steps go on from the next runs; the campaign's status and pause",
    params: campaignParams,
    response: campaignPauseResponse,
    errors: [errors.campaign_not_found, errors.campaign_not_paused],
  })
  async resume(@Param("campaignId") campaignId: string): Promise<CampaignPauseResponse> {
    return pauseResponse(await resumeCampaign(campaignId));
  }
}

/** A campaign's approval mode as the routes answer it, the lock's end in ISO 8601, UTC. */
function modeResponse(answer: ApprovalModeAnswer): ApprovalModeResponse {
  return { ...answer, lockedUntil: answer.lockedUntil.toISOString() };
}

/** A campaign's pause as the routes answer it, its instant in ISO 8601, UTC. */
function pauseResponse(campaign: CampaignPause): CampaignPauseResponse {
  return { ...campaign, pausedAt: campaign.pausedAt?.toISOString() ?? null };
}

/** A version's step as the routes answer it, its condition only when it has one. */
function stepResponse(step: VersionStep): StepResponse {
  const { position, stepKey, action, channel, delay, condition } = step;
  return { position, stepKey, action, channel, delay, ...(condition && { condition }) };
}

/** A campaign as the routes answer it, its instant in ISO 8601, UTC. */
function toResponse(campaign: CampaignSummary): CampaignsResponse["campaigns"][number] {
  const { id, name, status, ownerUserId, playbookId, versionNo, stepCount, launchedAt } = campaign;
  const launched = launchedAt?.toISOString() ?? null;
  return { id, name, status, ownerUserId, playbookId, versionNo, stepCount, launchedAt: launched };
}
