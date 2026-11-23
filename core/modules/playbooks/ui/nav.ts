// playbooks' screens (core/apps/web/docs/screens.md): the agents at /w/{workspace}/agents, in the
// navigation's ICP group after icp's ICP screen, and the agent's page at
// /w/{workspace}/agents/{playbookId}, outside it, whose `campaign` slot campaigns' panel fills
// (ui/agent/slots.ts, gamma-p3-065). The screens say agent; the code says playbook (README).
import { AGENTS_SEGMENT } from "./constants.ts";

export const nav = [
  {
    group: "icp",
    labelKey: "playbooks.nav.agents",
    segment: AGENTS_SEGMENT,
    screen: "agents",
    order: 20,
    icon: "Bot",
  },
];

export const pages = [{ path: `${AGENTS_SEGMENT}/[playbookId]`, screen: "agent" }];
