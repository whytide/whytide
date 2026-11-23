// An agent's campaign (README.md "Agents' campaigns"; gamma-p3-065): the body of the subscriber to
// playbooks.playbook_created (events.ts), in the delivery's transaction. campaigns imports playbooks
// and never the reverse, so the campaign is made on the agent's event: a draft named as the agent,
// the warm-signal steps as its version 1 (createCampaign's default), owned by the owner the event
// carries, made by the system and holding the agent's id. A redelivered event makes none, its insert
// skipped on campaigns_playbook; an agent the workspace no longer holds gets none.
import { getPlaybook } from "@whytide/playbooks";
import { createCampaign } from "./commands.ts";
import { CAMPAIGN_NAME_MAX, SYSTEM_AUTHOR } from "./constants.ts";

/** What a delivery did: the campaign made, the agent's one already there, or no agent. */
export type AgentCampaignOutcome = "made" | "made_already" | "agent_gone";

/** The agent's campaign made, unless it has one (the file's header). */
export async function makeAgentCampaign(created: {
  readonly playbookId: string;
  readonly ownerUserId: string;
}): Promise<AgentCampaignOutcome> {
  const playbook = await getPlaybook(created.playbookId);
  if (playbook === null) return "agent_gone";
  const { written } = await createCampaign({
    // The agent's name, as long as a campaign's may be: both bounds are 80 today.
    name: playbook.name.slice(0, CAMPAIGN_NAME_MAX),
    ownerUserId: created.ownerUserId,
    createdBy: SYSTEM_AUTHOR,
    playbookId: playbook.id,
  });
  return written ? "made" : "made_already";
}
