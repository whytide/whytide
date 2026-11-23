// The campaigns' reads (README.md "Campaigns and versions"), in the caller's tenant run: a campaign,
// an agent's campaign (gamma-p3-065, README.md "Agents' campaigns"), a version's steps by the pair
// enrollments carry (template_id, the campaign's key_ref, and template_version, the version's
// version_no), and the version a new enrollment joins. A version's rows never change, but nothing
// caches them: a run that rolls back would leave a version no one saved. Before its first read, the
// seeded campaign's version 1 is beta's template (SEEDED_VERSION), so beta's enrollments read the
// same steps with or without its rows.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import type { ApprovalMode } from "../approval-mode/constants.ts";
import { TEMPLATE_STEPS } from "../template/constants.ts";
import {
  type CampaignPauseReason,
  type CampaignStatus,
  FIRST_VERSION_NO,
  SEEDED_CAMPAIGN_KEY,
} from "./constants.ts";
import { keyedSteps, parseDelay, type VersionStep, validateSequence } from "./sequence.ts";

/** A campaign as its reads answer it. */
export type Campaign = {
  readonly id: string;
  readonly keyRef: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly ownerUserId: string;
  readonly currentVersionId: string | null;
  readonly launchedAt: Date | null;
  /** Set exactly while paused (gamma-p3-060). */
  readonly pausedReason: CampaignPauseReason | null;
  readonly pausedAt: Date | null;
  /** The agent it was made for, playbooks' id (gamma-p3-065); null for the seeded one. */
  readonly playbookId: string | null;
  /** Its approval mode and the end of its lock (gamma-p4-070, ../approval-mode/). */
  readonly approvalMode: ApprovalMode;
  readonly reviewLockedUntil: Date;
  /** Who last changed the mode and when; null until a member does. */
  readonly approvalModeSetBy: string | null;
  readonly approvalModeSetAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};
/** A version as enrollments name it, with its steps by position. */
export type CampaignVersion = {
  readonly keyRef: string;
  readonly versionNo: number;
  readonly steps: readonly VersionStep[];
};

/** Beta's template as the seeded campaign's version 1: its four steps, keys and hashes. */
export const SEEDED_VERSION: CampaignVersion = {
  keyRef: SEEDED_CAMPAIGN_KEY,
  versionNo: FIRST_VERSION_NO,
  steps: keyedSteps(validateSequence(TEMPLATE_STEPS)),
};

const CAMPAIGN = {
  id: true,
  keyRef: true,
  name: true,
  status: true,
  ownerUserId: true,
  currentVersionId: true,
  launchedAt: true,
  pausedReason: true,
  pausedAt: true,
  playbookId: true,
  approvalMode: true,
  reviewLockedUntil: true,
  approvalModeSetBy: true,
  approvalModeSetAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The workspace's campaign with the id; campaign_not_found. */
export async function campaignOf(campaignId: string): Promise<Campaign> {
  // Prisma drops an undefined value from a where: unchecked, that would be any campaign.
  const found =
    typeof campaignId === "string" && campaignId !== ""
      ? await tenantClient.campaign.findFirst({ where: { id: campaignId }, select: CAMPAIGN })
      : null;
  if (found === null) throw new AppError(errors.campaign_not_found);
  return found;
}

/** A campaign with its current version's number, null before its first, and step count. */
export type CampaignSummary = Campaign & {
  readonly versionNo: number | null;
  readonly stepCount: number;
};

/**
 * The workspace's campaigns, oldest first, each with its current version's number and steps; with
 * `playbookId`, the agent's only (gamma-p3-065).
 */
export async function campaignsOf(
  filter: { readonly playbookId?: string } = {},
): Promise<CampaignSummary[]> {
  const { playbookId } = filter;
  const campaigns = await tenantClient.campaign.findMany({
    where: playbookId === undefined ? {} : { playbookId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: CAMPAIGN,
  });
  const current = campaigns.flatMap(({ currentVersionId: id }) => (id === null ? [] : [id]));
  const versions = await tenantClient.campaignVersion.findMany({
    where: { id: { in: current } },
    select: { id: true, versionNo: true },
  });
  const counts = await tenantClient.step.groupBy({
    by: ["campaignVersionId"],
    where: { campaignVersionId: { in: current } },
    _count: { _all: true },
  });
  const versionNo = new Map(versions.map(({ id, versionNo }) => [id, versionNo]));
  const steps = new Map(counts.map(({ campaignVersionId: id, _count }) => [id, _count._all]));
  return campaigns.map((campaign) => {
    const id = campaign.currentVersionId ?? "";
    return { ...campaign, versionNo: versionNo.get(id) ?? null, stepCount: steps.get(id) ?? 0 };
  });
}

/** The agent's campaign (campaigns_playbook: one at most); null for none. */
export async function campaignOfPlaybook(playbookId: string): Promise<Campaign | null> {
  if (typeof playbookId !== "string" || playbookId === "") return null;
  return tenantClient.campaign.findFirst({ where: { playbookId }, select: CAMPAIGN });
}

/** The workspace's campaign with the key_ref; null for none. */
export async function campaignByKey(keyRef: string): Promise<Campaign | null> {
  if (typeof keyRef !== "string" || keyRef === "") return null;
  return tenantClient.campaign.findFirst({ where: { keyRef }, select: CAMPAIGN });
}

/**
 * The steps of the campaign's version, by position; the seeded campaign's version 1 is beta's
 * template while its rows are not there. Null for a version the workspace does not have.
 */
export async function versionSteps(
  keyRef: string,
  versionNo: number,
): Promise<readonly VersionStep[] | null> {
  const campaign = await campaignByKey(keyRef);
  const version =
    campaign === null || !Number.isInteger(versionNo)
      ? null
      : await tenantClient.campaignVersion.findFirst({
          where: { campaignId: campaign.id, versionNo },
          select: { id: true },
        });
  if (version !== null) return stepsOf(version.id);
  const seeded = keyRef === SEEDED_CAMPAIGN_KEY && versionNo === FIRST_VERSION_NO;
  return seeded ? SEEDED_VERSION.steps : null;
}

/** The version with the id, as enrollments name it; it is the campaign's own, by its foreign key. */
export async function versionOf(campaign: Campaign, versionId: string): Promise<CampaignVersion> {
  const version = await tenantClient.campaignVersion.findFirstOrThrow({
    where: { id: versionId, campaignId: campaign.id },
    select: { versionNo: true },
  });
  return { keyRef: campaign.keyRef, versionNo: version.versionNo, steps: await stepsOf(versionId) };
}

/** A version's steps by position, each delay as the template's StepDelay. */
async function stepsOf(versionId: string): Promise<VersionStep[]> {
  const rows = await tenantClient.step.findMany({
    where: { campaignVersionId: versionId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      stepKey: true,
      position: true,
      actionType: true,
      channel: true,
      delay: true,
      condition: true,
      stepTemplateHash: true,
    },
  });
  return rows.map(({ id, actionType, delay, condition, ...step }) => {
    const parsed = parseDelay(delay);
    if (parsed === null || actionType === "withdraw") throw new Error(`${id}: not a sequence step`);
    // A condition only when set, as keyedSteps gives it: beta's steps read as they did.
    return { ...step, action: actionType, delay: parsed, ...(condition !== null && { condition }) };
  });
}
