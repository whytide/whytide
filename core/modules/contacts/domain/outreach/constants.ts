// A lead's outreach status, its words and limits (docs/concepts.md "Outreach status"), beside the code
// that reads them: status.ts, rules.ts, the suppression write, the routes' schemas and the screens.

/**
 * Beta's flow: pending_review, approved, in_campaign, then replied or finished; suppressed from any
 * of them. The order is the enum's (contacts.prisma lead_outreach_status).
 */
export const OUTREACH_STATUSES = [
  "pending_review",
  "approved",
  "in_campaign",
  "replied",
  "finished",
  "suppressed",
] as const;

/** A campaign has the lead, or had it: Approve no longer applies (campaigns writes these). */
export const IN_OUTREACH = ["in_campaign", "replied", "finished"] as const;

/** Who changed a status: a user (Approve, a block by hand), or the system (a campaign, a reply). */
export const STATUS_ACTORS = ["user", "system"] as const;

/** The status-changes route answers the newest this many. */
export const STATUS_CHANGES_LIMIT = 100;

/** The reason a lead is suppressed with, by the entry that suppressed it: suppressionOf's words. */
export const SUPPRESSED_REASONS = {
  optOut: "opted_out",
  person: "never_contact_person",
  company: "never_contact_company",
} as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
export type StatusActorType = (typeof STATUS_ACTORS)[number];
