// The never-contact checks and a person's touches (README.md "Public interface"; docs/flows.md "The
// check"), inside the caller's tenant run like every query of contacts: whether outreach to a person
// is allowed now, or was by the list as it stood at an instant. No cache: every check reads the
// entries in the caller's run, so an entry added a moment before is seen (architecture §7.6, the
// just-in-time checks read the primary). A person the check does not know is suppressed: a check
// never fails open.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { requireId } from "../rules.ts";
import { companyHashes, decide, profileHash, type Suppression } from "./matching.ts";

/** What the check knows of a person: the hashes they are matched by, and their last touch. */
type Subject = {
  readonly profileHash: string;
  readonly companyHashes: readonly string[];
  readonly lastTouchAt: Date | null;
};

const NOT_FOUND: Suppression = { suppressed: true, reason: "person_not_found" };

/**
 * Whether outreach to the person is allowed now, and why not. The first that applies wins:
 * person_not_found, opted_out, never_contact_person, never_contact_company, then, for a new
 * enrollment, recently_contacted (a touch less than RECENT_TOUCH_DAYS ago). Anything but
 * `newEnrollment: false` counts as a new enrollment, the stricter answer.
 */
export async function suppressionOf(
  personId: string,
  options: { newEnrollment: boolean },
): Promise<Suppression> {
  const subject = await subjectOf(personId);
  if (subject === null) return NOT_FOUND;
  const entries = await tenantClient.suppressionEntry.findMany({
    where: { hash: { in: hashesOf(subject) }, removedAt: null },
    select: { layer: true, hash: true },
  });
  const newEnrollment = options?.newEnrollment !== false;
  return decide({ ...subject, entries, newEnrollment, now: new Date() });
}

/**
 * The same answer against the list as it stood at `at`: the entries created at or before it and not
 * removed by then, against the person's company of now; never recently_contacted. What a report on
 * past sends reads (beta-p7-020). contacts_input_invalid naming `at` for no instant.
 */
export async function suppressedAt(personId: string, at: Date): Promise<Suppression> {
  const instant = requireInstant(at);
  const subject = await subjectOf(personId);
  if (subject === null) return NOT_FOUND;
  const entries = await tenantClient.suppressionEntry.findMany({
    where: {
      hash: { in: hashesOf(subject) },
      createdAt: { lte: instant },
      OR: [{ removedAt: null }, { removedAt: { gt: instant } }],
    },
    select: { layer: true, hash: true },
  });
  return decide({ ...subject, entries, newEnrollment: false, now: instant });
}

/** The person's latest outbound touch, or null; person_not_found. */
export async function lastTouchAt(personId: string): Promise<Date | null> {
  const id = requireId("personId", personId);
  const person = await tenantClient.person.findFirst({
    where: { id },
    select: { lastTouchAt: true },
  });
  if (person === null) throw new AppError(errors.person_not_found);
  return person.lastTouchAt;
}

/**
 * Records an outbound touch: last_touch_at becomes the later of its value and `at`, in one statement,
 * so that no touch moves it back, whichever commits last; updated_at, the profile's, stays.
 * person_not_found; contacts_input_invalid naming `at` for no instant.
 */
export async function recordTouch(personId: string, at: Date): Promise<void> {
  const id = requireId("personId", personId);
  const instant = requireInstant(at);
  const { workspaceId } = currentTenant();
  const updated = await tenantClient.$executeRaw`
    UPDATE persons SET last_touch_at = GREATEST(last_touch_at, ${instant}::timestamptz)
    WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  if (updated === 0) throw new AppError(errors.person_not_found);
}

/** The person's hashes and last touch; null for an id of no person of the workspace. */
async function subjectOf(personId: unknown): Promise<Subject | null> {
  const id = knownId(personId);
  if (id === null) return null;
  const person = await tenantClient.person.findFirst({
    where: { id },
    select: { linkedinUrl: true, companyId: true, lastTouchAt: true },
  });
  if (person === null) return null;
  const company =
    person.companyId === null
      ? null
      : await tenantClient.workspaceCompany.findFirst({
          where: { id: person.companyId },
          select: { domain: true, linkedinUrl: true },
        });
  return {
    profileHash: profileHash(person.linkedinUrl),
    companyHashes: company === null ? [] : companyHashes(company),
    lastTouchAt: person.lastTouchAt,
  };
}

function hashesOf(subject: Subject): string[] {
  return [subject.profileHash, ...subject.companyHashes];
}

/** The id as the rules take one, or null: an id off them names no person, so the check refuses. */
function knownId(value: unknown): string | null {
  try {
    return requireId("personId", value);
  } catch {
    return null;
  }
}

function requireInstant(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new AppError(errors.contacts_input_invalid, { details: { fields: ["at"] } });
}
