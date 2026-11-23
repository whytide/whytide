// The host's test module (docs/screens.md "Playwright"): one screen, which `pnpm web:routes
// --fixtures` mounts at /w/{workspace}/fixture for the end-to-end tests, a panel in the evidence slot
// of contacts' lead page and one in its draft slot that throws on demand, the same one in the campaign
// slot of playbooks' agent page (gamma-p3-065); never in a production build.
export const nav = [
  {
    group: "company",
    labelKey: "fixture.nav.greeting",
    segment: "fixture",
    screen: "greeting",
    order: 10,
    icon: "Hand",
  },
];

export const panels = [
  { page: "contacts.lead", slot: "evidence", screen: "evidence" },
  { page: "contacts.lead", slot: "draft", screen: "failing" },
  { page: "playbooks.agent", slot: "campaign", screen: "failing" },
];
