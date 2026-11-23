// The module's screen in the web host's navigation (core/apps/web/docs/screens.md): /w/{ws}/sources;
// /w/{ws}/companies-found, the companies the Web research sources found (gamma-wr-111); and its panels: in
// the evidence slot of contacts' lead page, /w/{ws}/leads/{personId}, and in the companies slot of
// playbooks' agent page, /w/{ws}/agents/{id}.
export const nav = [
  {
    group: "sources",
    labelKey: "signals.nav.sources",
    segment: "sources",
    screen: "sources",
    order: 10,
    icon: "Radar",
  },
  {
    group: "sources",
    labelKey: "signals.nav.found",
    segment: "companies-found",
    screen: "found-companies",
    order: 20,
    icon: "Building2",
  },
];

export const panels = [
  { page: "contacts.lead", slot: "evidence", screen: "lead-evidence" },
  { page: "playbooks.agent", slot: "companies", screen: "agent-companies" },
];
