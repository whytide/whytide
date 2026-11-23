// The campaigns' commands (README.md "Campaigns and versions"; F08 §5.4), each in the caller's
// tenant run. seedCampaign makes the seeded campaign on first use, owned by the workspace's Owner,
// with beta's template as its version 1: only the run whose insert won writes the version, so two
// first reads at once leave one. createCampaign makes a draft with its version 1, the warm-signal
// template's steps unless it is given steps (gamma-p3-060), and for an agent at most one, its
// second insert skipped on campaigns_playbook (gamma-p3-065); saveVersion, under
// a lock on the campaign's row and nothing else, writes the next version unless the steps are the
// current ones; renameCampaign gives it a new name under the same lock (gamma-p3-050), and both
// check a name's bounds as campaign_name_invalid. A version, once written, is never changed (app may
// not update or delete its rows):
// an enrollment keeps the version it joined, and only new enrollments join a newer one. Every write
// of a campaign is its owner's or campaigns.manage's (lockCampaign, gamma-p6-015). Both makers lock
// the new campaign in review_everything for its first days, from its creation (gamma-p4-070).
import { tenantClient } from "@whytide/db";
import { AppError, canWriteOwned, currentTenant, newId } from "@whytide/platform";
import { workspaceOwner } from "@whytide/tenancy";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { permissions } from "../../permissions.ts";
import { reviewLockedUntilOf } from "../approval-mode/mode.ts";
import { now } from "../clock.ts";
import { WARM_SIGNAL_STEPS } from "../template/warm-signal.ts";
import {
  CAMPAIGN_NAME_MAX,
  FIRST_VERSION_NO,
  SEEDED_CAMPAIGN_KEY,
  SYSTEM_AUTHOR,
} from "./constants.ts";
import {
  type Campaign,
  type CampaignVersion,
  campaignByKey,
  campaignOf,
  campaignOfPlaybook,
  SEEDED_VERSION,
  versionOf,
} from "./reads.ts";
import {
  keyedSteps,
  type SequenceInput,
  sameSteps,
  type VersionStep,
  validateSequence,
} from "./sequence.ts";

/** A version written, or the current one when the steps were its own. */
export type SavedVersion = {
  readonly id: string;
  readonly versionNo: number;
  readonly written: boolean;
};

/**
 * The seeded campaign (the file's header): active, launched, owned by the user of the workspace's
 * oldest Owner membership. Null in a workspace without an Owner, where nothing is written and beta's
 * template stands as its version 1 (reads.ts SEEDED_VERSION).
 */
export async function seedCampaign(): Promise<Campaign | null> {
  const found = await campaignByKey(SEEDED_CAMPAIGN_KEY);
  if (found !== null) return found;
  const { workspaceId } = currentTenant();
  const ownerUserId = await workspaceOwner(workspaceId);
  if (ownerUserId === null) return null;
  const id = newId(ids.campaign);
  const at = now();
  const row = {
    id,
    workspaceId,
    keyRef: SEEDED_CAMPAIGN_KEY,
    name: "",
    status: "active",
    ownerUserId,
    launchedAt: at,
    reviewLockedUntil: reviewLockedUntilOf(at),
    createdBy: SYSTEM_AUTHOR,
  } as const;
  // ON CONFLICT DO NOTHING: a run that inserts at the same time waits for this one, then skips.
  const { count } = await tenantClient.campaign.createMany({ data: [row], skipDuplicates: true });
  if (count === 1) {
    const version = { versionNo: FIRST_VERSION_NO, createdBy: SYSTEM_AUTHOR };
    await writeVersion(id, version, SEEDED_VERSION.steps);
  }
  return campaignByKey(SEEDED_CAMPAIGN_KEY);
}

/**
 * What a new enrollment of the seeded campaign joins: its current version, or beta's template; and
 * whose senders it sends from, its owner's, the workspace's Owner (gamma-p6-040), null without one.
 */
export async function seededEnrollment(): Promise<{
  readonly version: CampaignVersion;
  readonly ownerUserId: string | null;
}> {
  const campaign = await seedCampaign();
  const ownerUserId = campaign?.ownerUserId ?? null;
  if (campaign?.currentVersionId == null) return { version: SEEDED_VERSION, ownerUserId };
  return { version: await versionOf(campaign, campaign.currentVersionId), ownerUserId };
}

/**
 * A draft campaign, its key_ref its own id, with the steps, or the warm signal's, as version 1. With
 * `playbookId`, the agent's (gamma-p3-065): when the agent has one already, the insert is skipped
 * and that campaign's current version answers, written false.
 */
export async function createCampaign(input: {
  readonly name: string;
  readonly steps?: readonly SequenceInput[];
  readonly ownerUserId: string;
  readonly createdBy: string;
  readonly playbookId?: string;
}): Promise<SavedVersion & { readonly campaignId: string }> {
  const name = campaignName(input.name);
  const ownerUserId = requireText("ownerUserId", input.ownerUserId);
  const createdBy = requireText("createdBy", input.createdBy);
  const playbookId =
    input.playbookId === undefined ? null : requireText("playbookId", input.playbookId);
  const steps = keyedSteps(validateSequence(input.steps ?? WARM_SIGNAL_STEPS));
  const { workspaceId } = currentTenant();
  const id = newId(ids.campaign);
  const reviewLockedUntil = reviewLockedUntilOf(now());
  const row = { id, workspaceId, keyRef: id, name, ownerUserId, createdBy, playbookId };
  // ON CONFLICT DO NOTHING: an agent's second campaign meets campaigns_playbook, and one inserted at
  // the same time waits for the other's run, then skips.
  const data = [{ ...row, status: "draft", reviewLockedUntil } as const];
  const { count } = await tenantClient.campaign.createMany({ data, skipDuplicates: true });
  if (count === 0) return agentsCampaign(playbookId);
  const version = await writeVersion(id, { versionNo: FIRST_VERSION_NO, createdBy }, steps);
  return { campaignId: id, ...version };
}

/** The agent's campaign a skipped insert met, its current version written false. */
async function agentsCampaign(
  playbookId: string | null,
): Promise<SavedVersion & { readonly campaignId: string }> {
  const campaign = playbookId === null ? null : await campaignOfPlaybook(playbookId);
  // A skip without an agent's campaign is a key the insert cannot meet: a developer's mistake.
  if (campaign?.currentVersionId == null) throw new Error("createCampaign: insert skipped");
  const { id, versionNo } = await tenantClient.campaignVersion.findFirstOrThrow({
    where: { id: campaign.currentVersionId, campaignId: campaign.id },
    select: { id: true, versionNo: true },
  });
  return { campaignId: campaign.id, id, versionNo, written: false };
}

/**
 * The steps saved as the campaign's next version (the file's header): the current version, written
 * false, when they are its steps; campaign_not_found, campaign_archived (409) and
 * campaign_sequence_invalid.
 */
export async function saveVersion(
  campaignId: string,
  steps: readonly SequenceInput[],
  options: { readonly createdBy: string },
): Promise<SavedVersion> {
  const createdBy = requireText("createdBy", options?.createdBy);
  const campaign = await lockCampaign(campaignId);
  if (campaign.status === "archived") throw new AppError(errors.campaign_archived);
  const next = keyedSteps(validateSequence(steps));
  if (campaign.currentVersionId !== null) {
    const current = await versionOf(campaign, campaign.currentVersionId);
    if (sameSteps(current.steps, next)) {
      return { id: campaign.currentVersionId, versionNo: current.versionNo, written: false };
    }
  }
  const { _max } = await tenantClient.campaignVersion.aggregate({
    where: { campaignId: campaign.id },
    _max: { versionNo: true },
  });
  const versionNo = (_max.versionNo ?? 0) + 1;
  return writeVersion(campaign.id, { versionNo, createdBy }, next);
}

/** The campaign renamed, its name trimmed (gamma-p3-050); campaign_name_invalid, campaign_not_found. */
export async function renameCampaign(
  campaignId: string,
  input: string,
): Promise<{ readonly id: string; readonly name: string }> {
  const name = campaignName(input);
  const campaign = await lockCampaign(campaignId);
  await tenantClient.campaign.updateMany({ where: { id: campaign.id }, data: { name } });
  return { id: campaign.id, name };
}

/** A campaign's name, trimmed, 1 to CAMPAIGN_NAME_MAX characters; else campaign_name_invalid. */
function campaignName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name === "" || name.length > CAMPAIGN_NAME_MAX) {
    throw new AppError(errors.campaign_name_invalid);
  }
  return name;
}

/**
 * The campaign, its row locked until the run ends, so two saves, renames, pauses or launches of it
 * queue; campaign_not_found. Every write of a campaign comes here, so here the caller is checked
 * (README.md "Decided here"): its owner, or a holder of campaigns.manage, through platform's
 * canWriteOwned; anyone else is forbidden, before anything is written. The seeded campaign is the
 * workspace's Owner's, so a Member never writes it.
 */
export async function lockCampaign(campaignId: string): Promise<Campaign> {
  if (typeof campaignId !== "string" || campaignId === "") {
    throw new AppError(errors.campaign_not_found);
  }
  const { workspaceId, principal } = currentTenant();
  await tenantClient.$queryRaw`
    SELECT id FROM campaigns WHERE workspace_id = ${workspaceId} AND id = ${campaignId} FOR UPDATE`;
  // Read under the lock: a save that held it may have moved the current version.
  const campaign = await campaignOf(campaignId);
  const owned = {
    ownerUserId: campaign.ownerUserId,
    manageAction: permissions["campaigns.manage"],
  };
  const decision = canWriteOwned(principal, owned);
  if (decision !== "allow") throw new AppError(decision);
  return campaign;
}

/** The version and its steps written, and made the campaign's current one. */
async function writeVersion(
  campaignId: string,
  version: { readonly versionNo: number; readonly createdBy: string },
  steps: readonly VersionStep[],
): Promise<SavedVersion> {
  const { workspaceId } = currentTenant();
  const id = newId(ids.campaign_version);
  const changeKind = version.versionNo === FIRST_VERSION_NO ? "initial" : "structural";
  await tenantClient.campaignVersion.create({
    data: { id, workspaceId, campaignId, ...version, changeKind },
  });
  await tenantClient.step.createMany({
    data: steps.map((step) => ({
      ...{ id: newId(ids.step), workspaceId, campaignVersionId: id },
      ...{ position: step.position, stepKey: step.stepKey, actionType: step.action },
      ...{ channel: step.channel, delay: step.delay, stepTemplateHash: step.stepTemplateHash },
      condition: step.condition ?? null,
    })),
  });
  await tenantClient.campaign.updateMany({
    where: { id: campaignId },
    data: { currentVersionId: id },
  });
  return { id, versionNo: version.versionNo, written: true };
}

/** A required id or author: a developer's mistake when missing. */
function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}: required`);
  return value;
}
