// The lead deletion (README.md "Deleting a lead", docs/flows.md "Delete a lead"): a person no channel
// ever reached and no never-contact entry stops, deleted through erase, every module's rows in one
// tenant run, as the service privacy, with the reason lead_deleted and no erased hash, so that the
// same URL, or address, can be added again by hand, by an import or by a signal. The guard, right after the lead's
// lock: no touch (contacts' lastTouchAt), no step that went out, the person's steps locked from then
// on (campaigns' lockPersonSteps), and no entry the never-contact check reads (contacts'
// suppressionOf); the recheck, on the person's row locked right before its delete: still no touch,
// and no outreach row or thread among the rows the erasers deleted. A refusal rolls everything back.
import { lockPersonSteps } from "@whytide/campaigns";
import {
  errors as contactsErrors,
  type LockedPerson,
  lastTouchAt,
  suppressionOf,
} from "@whytide/contacts";
import { type Erasure, type ErasureRequest, type ErasureSkipped, erase } from "../erase/erase.ts";
import type { Eraser, ErasureCounts } from "../erase/registry.ts";
import { CONTACT_ROWS, LEAD_DELETED, PERSON_CONTACTED, PERSON_SUPPRESSED } from "./constants.ts";

/**
 * What the command asks: the workspace, the person by id, URL or email address, the operator, a dry
 * run or not.
 */
export type LeadDeletion = Pick<ErasureRequest, "workspaceId" | "person" | "operator" | "dryRun">;

/**
 * Deletes the person's lead and every row of theirs, or answers the refusal, `{ skipped }` with
 * person_contacted or person_suppressed, nothing changed. person_not_found, linkedin_url_invalid,
 * contacts_input_invalid: nothing ran. `erasers` is for tests: the registered ones by default.
 */
export function deleteLead(
  request: LeadDeletion,
  erasers?: readonly Eraser[],
): Promise<Erasure | ErasureSkipped> {
  const checks = { guard: neverContacted, recheck: stillNeverContacted };
  return erase({ ...request, reason: LEAD_DELETED, ...checks }, erasers);
}

/**
 * The guard, after the lead's lock: a touch, then a step that went out, the person's steps locked
 * from here on, so that a claim waits for the run, refuse as person_contacted; then any entry the
 * never-contact check reads, the person's or their company's, as person_suppressed.
 */
async function neverContacted(personId: string): Promise<string | null> {
  if ((await lastTouchAt(personId)) !== null) return PERSON_CONTACTED;
  if ((await lockPersonSteps(personId)).wentOut > 0) return PERSON_CONTACTED;
  const suppression = await suppressionOf(personId, { newEnrollment: false });
  if (!suppression.suppressed) return null;
  // Gone since the touch's read: erased by another run meanwhile.
  const gone = suppression.reason === contactsErrors.person_not_found;
  return gone ? suppression.reason : PERSON_SUPPRESSED;
}

/**
 * The recheck, on the person's row locked right before its delete, which waits for a touch still
 * being written: a touch, or an outreach row or a thread among the rows the erasers deleted, refuse
 * as person_contacted.
 */
async function stillNeverContacted(
  person: LockedPerson,
  erased: Readonly<Record<string, ErasureCounts>>,
): Promise<string | null> {
  if (person.lastTouchAt !== null) return PERSON_CONTACTED;
  const left = CONTACT_ROWS.some(([module, table]) => (erased[module]?.[table] ?? 0) > 0);
  return left ? PERSON_CONTACTED : null;
}
