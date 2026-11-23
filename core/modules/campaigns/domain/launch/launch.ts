// The launch (README.md "Launch checks"; docs/flows.md "Saving and launching"), each in the
// caller's tenant run: launchChecks reads the checks for the screen, and launchCampaign is the one
// path out of `draft`: the campaign's row locked, then every check read again under the lock, never
// the screen's answer trusted, and only with all of them passing the campaign `active` with its
// launch time. A refusal writes nothing. Its enrollments' steps then go as any active campaign's,
// each through its approval, the plan, the gate and linkedin's reservation.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { lockCampaign } from "../campaigns/commands.ts";
import { campaignOf } from "../campaigns/reads.ts";
import { now } from "../clock.ts";
import { checkLaunch, type LaunchCheckResult } from "./checks.ts";

/** A launched campaign: its status and its launch time. */
export type LaunchedCampaign = {
  readonly id: string;
  readonly status: "active";
  readonly launchedAt: Date;
};

/** The campaign's checks, read now; campaign_not_found. */
export async function launchChecks(campaignId: string): Promise<LaunchCheckResult[]> {
  return checkLaunch(await campaignOf(campaignId));
}

/**
 * The draft campaign `active` with launched_at now, once every check passes again under its lock;
 * campaign_not_found, campaign_not_draft, and campaign_launch_blocked with `details.checks`.
 */
export async function launchCampaign(campaignId: string): Promise<LaunchedCampaign> {
  const campaign = await lockCampaign(campaignId);
  if (campaign.status !== "draft") throw new AppError(errors.campaign_not_draft);
  const checks = await checkLaunch(campaign);
  if (checks.some(({ ok }) => !ok)) {
    throw new AppError(errors.campaign_launch_blocked, { details: { checks } });
  }
  const launched = { status: "active", launchedAt: now() } as const;
  await tenantClient.campaign.updateMany({
    where: { id: campaign.id, status: "draft" },
    data: launched,
  });
  return { id: campaign.id, ...launched };
}
