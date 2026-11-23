// Routing (README.md "Enrolling", "Agents' campaigns"; gamma-p3-065): the campaign an approved lead
// joins, read in the enrollment's run (enroll.ts) after the lead's lock and before beta's checks.
// The source decides, not the audience: the lead's oldest source of kind `signal` (contacts'
// `sources`, in arrival order), whose `ref` is the signal source's id; the agent holding that source
// (playbooks' playbookOfSource: one source, one agent); and that agent's campaign, unless it is
// archived. No such source, no agent, no campaign, or one archived: null, and the enrollment joins
// the seeded campaign as beta's did. A later source's agent is never asked: the oldest source alone
// decides. An archived agent holds no source (playbooks frees them), so its leads go elsewhere.
import { getLead, type LeadSource } from "@whytide/contacts";
import { playbookOfSource } from "@whytide/playbooks";
import { type Campaign, campaignOfPlaybook } from "../campaigns/reads.ts";
import { SIGNAL_SOURCE_KIND } from "./constants.ts";

/** The `ref` of the oldest source of kind `signal`, by its time, the earlier entry on a tie. */
export function oldestSignalSource(sources: readonly LeadSource[]): string | null {
  let oldest: LeadSource | null = null;
  for (const source of sources) {
    if (source.kind !== SIGNAL_SOURCE_KIND) continue;
    if (oldest === null || Date.parse(source.at) < Date.parse(oldest.at)) oldest = source;
  }
  return oldest?.ref ?? null;
}

/** An agent's campaign as routing answers it: with the current version its enrollments join. */
export type RoutedCampaign = Campaign & { readonly currentVersionId: string };

/**
 * The agent's campaign the person's lead joins; null for the seeded campaign (the file's header).
 * The caller holds the lead's lock, so the lead is there to read.
 */
export async function routedCampaign(personId: string): Promise<RoutedCampaign | null> {
  const { sources } = await getLead(personId);
  const sourceId = oldestSignalSource(sources);
  const playbookId = sourceId === null ? null : await playbookOfSource(sourceId);
  const campaign = playbookId === null ? null : await campaignOfPlaybook(playbookId);
  if (campaign === null || campaign.status === "archived") return null;
  const { currentVersionId } = campaign;
  // Every campaign is written with its version 1: one without stands for no campaign.
  return currentVersionId === null ? null : { ...campaign, currentVersionId };
}
