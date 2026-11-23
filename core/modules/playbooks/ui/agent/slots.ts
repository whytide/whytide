// The slots of the agent's page (README "Screens"): the places where other modules' panels render,
// each panel a `panels` entry of the module's ui/nav.ts, `{ page: "playbooks.agent", slot, screen }`,
// whose ui/<screen>/panel.tsx default-exports a component taking PanelProps
// (core/apps/web/docs/screens.md). `campaign`: campaigns' panel, the agent's campaign (gamma-p3-065). `companies`: signals' panel, the agent's newest fitting
// companies (gamma-wr-111).
// The web's route generator refuses a slot that is not listed here.
export const slots = ["campaign", "companies"] as const;
export type AgentSlot = (typeof slots)[number];
/** What the page gives each panel: the workspace as the URL names it (its id or slug) and the agent. */
export type PanelProps = { readonly workspace: string; readonly playbookId: string };
