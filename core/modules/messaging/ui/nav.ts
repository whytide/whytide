// messaging's panels: the draft panel in the draft slot of contacts' lead page,
// /w/{ws}/leads/{personId} (README.md "The draft panel"), and the AI disclosure line in the
// disclosure slot of approvals' "Up next" (README.md "The disclosure line"; gamma-p4-090) and of
// campaigns' campaign page, in its approval mode's card (gamma-p4-070)
// (core/apps/web/docs/screens.md).
export const panels = [
  { page: "contacts.lead", slot: "draft", screen: "draft-panel" },
  { page: "approvals.up-next", slot: "disclosure", screen: "disclosure" },
  { page: "campaigns.campaign", slot: "disclosure", screen: "disclosure" },
];
