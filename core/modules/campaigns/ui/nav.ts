// campaigns' screens (core/apps/web/docs/screens.md; README.md "Screens"): "Campaigns" at
// /w/{ws}/campaigns, in the navigation's leads group after contacts' leads (their order 10), and the
// campaign's page at /w/{ws}/campaigns/{campaignId}, outside it (gamma-p3-051); "Counts" at
// /w/{ws}/counts, in the LinkedIn group, after linkedin's accounts (its order 10), since the shell's
// groups are a closed list; "Results" at /w/{ws}/results, first in the results group
// (gamma-p6-080); "Health" at /w/{ws}/health, second in it (gamma-p6-085); the panel in the outreach slot of contacts' lead page, /w/{ws}/leads/{personId}:
// the person's enrollments; and the panel in the campaign slot of playbooks' agent page,
// /w/{ws}/agents/{playbookId}: the agent's campaign (gamma-p3-065).
import { CAMPAIGNS_SEGMENT } from "./constants.ts";

export const nav = [
  {
    group: "leads",
    labelKey: "campaigns.nav.campaigns",
    segment: CAMPAIGNS_SEGMENT,
    screen: "campaigns",
    order: 12,
    icon: "Workflow",
  },
  {
    group: "linkedin",
    labelKey: "campaigns.nav.counts",
    segment: "counts",
    screen: "counts",
    order: 20,
    icon: "ChartColumn",
  },
  {
    group: "results",
    labelKey: "campaigns.nav.results",
    segment: "results",
    screen: "results",
    order: 10,
    icon: "ChartNoAxesColumn",
  },
  {
    group: "results",
    labelKey: "campaigns.nav.health",
    segment: "health",
    screen: "health",
    order: 20,
    icon: "HeartPulse",
  },
];

export const pages = [{ path: `${CAMPAIGNS_SEGMENT}/[campaignId]`, screen: "campaign" }];

export const panels = [
  { page: "contacts.lead", slot: "outreach", screen: "enrollment-panel" },
  { page: "playbooks.agent", slot: "campaign", screen: "agent-campaign" },
];
