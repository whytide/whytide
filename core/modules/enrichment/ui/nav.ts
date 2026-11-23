// enrichment's screens (core/apps/web/docs/screens.md; README.md "The lead page"): the panels in the
// company slot of contacts' lead page, /w/{ws}/leads/{personId}, under the evidence: the company's
// facts and the lead's country, each with where it came from and when, and "Enrich now"
// (gamma-en-055); under it, the lead's email with "Find email" or "Verify again" (gamma-en-081,
// README.md "The Email panel"). No screen of its own in the navigation.
export const panels = [
  { page: "contacts.lead", slot: "company", screen: "company-panel" },
  { page: "contacts.lead", slot: "company", screen: "email-panel" },
];
