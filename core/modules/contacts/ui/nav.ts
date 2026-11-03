// contacts' screens (core/apps/web/docs/screens.md): the lead list at /w/{workspace}/leads and the
// never-contact list at /w/{workspace}/never-contact, in the navigation's Leads group, and the lead
// page at /w/{workspace}/leads/{personId}, outside it, whose slots other modules' panels fill
// (ui/lead/slots.ts), contacts' own review panel among them.
export const nav = [
  {
    group: "leads",
    labelKey: "contacts.leads.title",
    segment: "leads",
    screen: "leads",
    order: 10,
    icon: "Users",
  },
  {
    group: "leads",
    labelKey: "contacts.never_contact.title",
    segment: "never-contact",
    screen: "never-contact",
    order: 20,
    icon: "Ban",
  },
];

export const pages = [{ path: "leads/[personId]", screen: "lead" }];

export const panels = [{ page: "contacts.lead", slot: "review", screen: "review-panel" }];
