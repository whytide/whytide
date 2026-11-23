// The lead page's company facts (gamma-en-055; README "The lead page"), beside the readers that use
// them: the company's fields the panel shows, in its order, and who may ask for a run. Pure: the
// panel imports it too.

/** The company's fields the panel shows, in order, as contacts' WorkspaceCompany names them. */
export const PANEL_FIELDS = [
  "domain",
  "linkedinUrl",
  "industry",
  "sizeRange",
  "employeeCount",
  "country",
  "description",
] as const;
export type PanelField = (typeof PANEL_FIELDS)[number];

/** contacts' field of the person's country, under which its provenance is kept. */
export const PERSON_COUNTRY_FIELD = "locationCountry";

/** The roles that read a lead's enrichment and ask for a run (permissions.ts), the panel's button. */
export const READ_ROLES = ["Owner", "Admin", "Member"] as const;
export const RUN_ROLES = ["Owner", "Admin", "Member"] as const;

/** A run's statuses and triggers, as enrichment_runs keeps them (docs/data.md). */
export const RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export const RUN_TRIGGERS = ["new_lead", "request"] as const;
/** The statuses of a run still at work: the panel's button waits while its run has one. */
export const WORKING_STATUSES = ["queued", "running"] as const;

/** The Email panel's two requests (gamma-en-081): a lookup, priced, or the held address checked again, free. */
export const EMAIL_ACTIONS = ["find", "verify"] as const;
export type EmailAction = (typeof EMAIL_ACTIONS)[number];
/**
 * Each action's request key: the member's Idempotency-Key under its own prefix, so that a key of the
 * panel never meets a key of the email step's (gamma-p4-010), nor one action's the other's.
 */
export const EMAIL_KEY_PREFIX: Readonly<Record<EmailAction, string>> = {
  find: "request",
  verify: "reverify",
};
/** A lookup's statuses and triggers, as enrichment_requests keeps them (docs/data.md). */
export const LOOKUP_STATUSES = [
  "queued",
  "running",
  "found",
  "not_found",
  "failed",
  "skipped_suppressed",
  "waiting_budget",
  "waiting_allowance",
] as const;
export const LOOKUP_TRIGGERS = ["jit_step", "request", "reverify", "found"] as const;
/** The advisory lock of a person's panel requests, `<prefix>:<workspace>:<person>`: one at a time. */
export const LEAD_EMAIL_LOCK = "enrichment.lead-email";
/** The price the Email panel shows before "Find email" (prices.ts). */
export const WORK_EMAIL_ACTION = "enrichment.work_email";
