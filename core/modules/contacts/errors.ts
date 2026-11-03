// contacts' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** upsertPersonFromSource: the person was erased from the workspace; nothing is written. 409. */
  person_erased: { status: 409 },
  /** No person of the workspace has the id. 404. */
  person_not_found: {},
  /** linkPersonToCompany: no company of the workspace has the id. 404. */
  company_not_found: {},
  /** The person has no lead in the workspace, or is another workspace's. 404. */
  lead_not_found: {},
  /** Not a LinkedIn profile URL, linkedin.com/in/<slug> (or a company page for a company). 400. */
  linkedin_url_invalid: {},
  /** A command's input off its rule (domain/rules.ts); `details.fields` names the fields. 400. */
  contacts_input_invalid: {},
  /** A hash was needed and HASH_SALT is not set (README.md "Settings"). 500. */
  hash_salt_missing: { status: 500 },
  /** reviewLead: Not a fit without a reason code. 400. */
  review_reason_required: { status: 400 },
  /** reviewLead: Good lead, or Not a fit for `other`, without its text. 400. */
  review_text_required: { status: 400 },
  /** removeSuppression: no active entry of the workspace has the id. 404. */
  suppression_not_found: {},
  /** removeSuppression: the entry is an opt-out, which is never removed. 409. */
  suppression_not_removable: { status: 409 },
  /**
   * addSuppression: the value normalizes to no profile, company page or domain of two labels or
   * more, or the company has neither a domain nor a page. 400.
   */
  suppression_target_invalid: { status: 400 },
  /**
   * approveLead: the never-contact check refuses the person as a new enrollment;
   * `details.reason` is its reason, recently_contacted included. 409.
   */
  person_suppressed: { status: 409 },
  /**
   * approveLead: a campaign has the lead or had it (in_campaign, replied, finished, or suppressed
   * after an enrollment), so Approve no longer applies. 409.
   */
  lead_in_outreach: { status: 409 },
});
