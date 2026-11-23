// qualification's panels on contacts' lead page (core/apps/web/docs/screens.md; README "Screen"): the
// lead's Re-score and what comes next for it, in the page header's actions slot; the audience the
// lead was judged against, and its priority, tier and intent with why now and each signal's share,
// in the evidence slot.
export const panels = [
  { page: "contacts.lead", slot: "actions", screen: "rescore-action" },
  { page: "contacts.lead", slot: "evidence", screen: "intent-panel" },
];
