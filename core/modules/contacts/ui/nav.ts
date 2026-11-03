// contacts' screens (core/apps/web/docs/screens.md): the lead list at /w/{workspace}/leads, in the
// navigation's Leads group, and the lead page at /w/{workspace}/leads/{personId}, outside it, whose
// slots other modules' panels fill (ui/lead/slots.ts), contacts' own review panel among them.
export const nav = [
  {
    group: "leads",
    labelKey: "contacts.leads.title",
    segment: "leads",
    screen: "leads",
    order: 10,
    icon: "Users",
  },
];

export const pages = [{ path: "leads/[personId]", screen: "lead" }];

export const panels = [{ page: "contacts.lead", slot: "review", screen: "review-panel" }];
