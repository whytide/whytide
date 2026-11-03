// campaigns' screens (core/apps/web/docs/screens.md; README.md "Screens"): "Counts" at
// /w/{ws}/counts, in the navigation's LinkedIn group, after linkedin's accounts (its order 10), since
// the shell's groups are a closed list; and the panel in the outreach slot of contacts' lead page,
// /w/{ws}/leads/{personId}: the person's enrollments.
export const nav = [
  {
    group: "linkedin",
    labelKey: "campaigns.nav.counts",
    segment: "counts",
    screen: "counts",
    order: 20,
    icon: "ChartColumn",
  },
];

export const panels = [{ page: "contacts.lead", slot: "outreach", screen: "enrollment-panel" }];
