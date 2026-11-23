// Pausing a campaign (README.md "Pausing"; docs/flows.md "Pausing"), each command in the caller's
// tenant run, the campaign's row locked (../campaigns/commands.ts lockCampaign): pauseCampaign
// moves an `active` campaign to `paused` with its reason and instant, and resumeCampaign moves it
// back, clearing the code its enrollments' steps waited on, each enrollment's under its lead's
// lock, then its own, the order every stop and every pause takes (gamma-p3-061). A draft is never
// paused: it has not started. While a campaign is not active, no step of its enrollments is opened,
// placed or claimed (status.ts); its enrollments stay `active`, live for every stop. The bounce
// rate's pause takes pauseCampaign with bounce_rate, wired by a later task.
import { lockLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { lockCampaign } from "../campaigns/commands.ts";
import {
  CAMPAIGN_PAUSE_REASONS,
  type CampaignPauseReason,
  type CampaignStatus,
} from "../campaigns/constants.ts";
import { now } from "../clock.ts";
import type { PauseCode } from "../steps/constants.ts";
import { lockEnrollment } from "../steps/skip.ts";

/** A campaign's pause as the commands answer it. */
export type CampaignPause = {
  readonly id: string;
  readonly status: CampaignStatus;
  readonly pausedReason: CampaignPauseReason | null;
  readonly pausedAt: Date | null;
};

/** The active campaign `paused` for `reason`, now; campaign_not_found, campaign_not_active. */
export async function pauseCampaign(
  campaignId: string,
  options: { readonly reason: CampaignPauseReason },
): Promise<CampaignPause> {
  const reason = options?.reason;
  if (!(CAMPAIGN_PAUSE_REASONS as readonly unknown[]).includes(reason)) {
    throw new Error(`pauseCampaign: a reason of ${CAMPAIGN_PAUSE_REASONS.join(", ")}`);
  }
  const campaign = await lockCampaign(campaignId);
  if (campaign.status !== "active") throw new AppError(errors.campaign_not_active);
  const paused = { status: "paused", pausedReason: reason, pausedAt: now() } as const;
  await tenantClient.campaign.updateMany({
    where: { id: campaign.id, status: "active" },
    data: paused,
  });
  return { id: campaign.id, ...paused };
}

/** The paused campaign `active` again; campaign_not_found, campaign_not_paused. */
export async function resumeCampaign(campaignId: string): Promise<CampaignPause> {
  const campaign = await lockCampaign(campaignId);
  if (campaign.status !== "paused") throw new AppError(errors.campaign_not_paused);
  const active = { status: "active", pausedReason: null, pausedAt: null } as const;
  await tenantClient.campaign.updateMany({
    where: { id: campaign.id, status: "paused" },
    data: active,
  });
  // Its enrollments' steps no longer wait on it: the plan places them again. Each enrollment's
  // under the lead's lock, then its own, in the enrollments' id order, as the timed resume takes
  // them; the steps read again under them, as a stop or a claim may have moved one meanwhile.
  const waiting = {
    status: "scheduled",
    errorCode: "campaign_not_active" satisfies PauseCode,
  } as const;
  const steps = await tenantClient.stepExecution.findMany({
    where: { templateId: campaign.keyRef, ...waiting },
    select: { enrollmentId: true, personId: true },
    orderBy: [{ enrollmentId: "asc" }, { id: "asc" }],
  });
  const enrollments = new Map(steps.map(({ enrollmentId, personId }) => [enrollmentId, personId]));
  for (const [enrollmentId, personId] of enrollments) {
    await lockLeadStatus(personId);
    await lockEnrollment(tenantClient, enrollmentId);
    await tenantClient.stepExecution.updateMany({
      where: { enrollmentId, ...waiting },
      data: { errorCode: null },
    });
  }
  return { id: campaign.id, ...active };
}
