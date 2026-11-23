// contacts' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** upsertPersonFromSource: the person was erased from the workspace; nothing is written. 409. */
  person_erased: { status: 409 },
  /**
   * upsertPersonFromSource (gamma-rf-050): the profile URL and the email address find two persons,
   * or the address's person has another URL; nothing is written. 409.
   */
  person_conflict: { status: 409 },
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
   * `details.reason` is its reason, recently_contacted included, with `details.days`, the
   * CONTACTS_RECENT_TOUCH_DAYS configured. 409.
   */
  person_suppressed: { status: 409 },
  /**
   * approveLead: a campaign has the lead or had it (in_campaign, replied, finished, or suppressed
   * after an enrollment), so Approve no longer applies. 409.
   */
  lead_in_outreach: { status: 409 },
  /**
   * createLeadByMember: the workspace already has a lead for the URL's person; `details.personId`
   * is that person's id, and nothing changes. 409.
   */
  lead_exists: { status: 409 },
  /**
   * An exclusion list's upload (gamma-p2-045): not multipart, no part named *.csv, a field or a
   * second part, a ZIP signature or a NUL byte, or a malformed CSV. Nothing is written. 400.
   */
  exclusions_unsupported_type: { status: 400 },
  /** An exclusion list's file is not UTF-8. Nothing is written. 400. */
  exclusions_bad_encoding: { status: 400 },
  /** An exclusion list's file has no header naming `domain`. Nothing is written. 400. */
  exclusions_missing_column: { status: 400 },
  /** An exclusion list's file holds more data rows than EXCLUSIONS_IMPORT_MAX_ROWS. 400. */
  exclusions_too_many_rows: { status: 400 },
  /**
   * An exclusion list's file holds more bytes than EXCLUSIONS_IMPORT_MAX_BYTES, or the body twice
   * that; the connection closes with the rest unread. 413.
   */
  exclusions_too_large: { status: 413 },
  /** No row of an exclusion list's file holds a domain. Nothing is written. 400. */
  exclusions_no_valid_row: { status: 400 },
  /** removeExclusionList: no list of the workspace has the id, or it is removed already. 404. */
  exclusion_list_not_found: {},
});
