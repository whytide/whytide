// The module's screen in the web host's navigation (core/apps/web/docs/screens.md): /w/{ws}/sources;
// and its panel in the evidence slot of contacts' lead page, /w/{ws}/leads/{personId}.
export const nav = [
  {
    group: "sources",
    labelKey: "signals.nav.sources",
    segment: "sources",
    screen: "sources",
    order: 10,
    icon: "Radar",
  },
];

export const panels = [{ page: "contacts.lead", slot: "evidence", screen: "lead-evidence" }];
