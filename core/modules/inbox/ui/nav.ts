// inbox's screens (core/apps/web/docs/screens.md): "Inbox" at /w/{workspace}/inbox, in the
// navigation's Leads group, right after approvals' "Up next" (its order 15) and before contacts'
// never-contact list (20); and a thread at /w/{workspace}/inbox/{threadId}, outside it.
export const nav = [
  {
    group: "leads",
    labelKey: "inbox.nav.inbox",
    segment: "inbox",
    screen: "inbox",
    order: 17,
    icon: "Inbox",
  },
];

export const pages = [{ path: "inbox/[threadId]", screen: "thread" }];
