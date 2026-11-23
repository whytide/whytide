// The lead deletion's values (README.md "Deleting a lead"), beside delete.ts, which reads them.
import type { ErasureReason } from "../erase/log.ts";

/** The log row's reason: no erased hash is written, and the row keeps none. */
export const LEAD_DELETED: ErasureReason = "lead_deleted";

/** The refusal of a person ever contacted: theirs is `pnpm erase` (docs/runbook.md). */
export const PERSON_CONTACTED = "person_contacted";

/** The refusal of a person the never-contact check stops: an opt-out or a never-contact entry. */
export const PERSON_SUPPRESSED = "person_suppressed";

/**
 * The rows the erasers delete that only a contact leaves, by module and table as they count them:
 * linkedin's outreach row of an account and the person, and an inbox thread.
 */
export const CONTACT_ROWS = [
  ["linkedin", "sender_outreach"],
  ["inbox", "threads"],
] as const;
