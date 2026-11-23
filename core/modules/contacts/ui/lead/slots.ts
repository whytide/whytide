// The slots of the lead page (docs/flows.md "The lead page"): the places where other modules' panels
// render, each panel a `panels` entry of the module's ui/nav.ts, `{ page: "contacts.lead", slot,
// screen }`, whose ui/<screen>/panel.tsx default-exports a component taking PanelProps
// (core/apps/web/docs/screens.md). The web's route generator refuses a slot that is not listed here.
// `outreach` (beta-p2-030) stands beside `review`: campaigns' enrollment panel (beta-p2-060).
// `company` (gamma-en-040), under `evidence`: enrichment's company panel (gamma-en-055).
export const slots = [
  "evidence",
  "company",
  "draft",
  "review",
  "actions",
  "cost",
  "outreach",
] as const;
export type LeadSlot = (typeof slots)[number];
/** What the page gives each panel: the workspace as the URL names it (its id or slug) and the person. */
export type PanelProps = { readonly workspace: string; readonly personId: string };
