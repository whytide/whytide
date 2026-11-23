// What the email tasks read and do with a person's address (README "Email lookups"), in the caller's
// tenant run: the address an email may go to, a work one first, a personal one only while it needs
// no consent (the owner's UK and EU switch); its value for the builder; a bounce, after which neither
// reader answers it and a later lookup ends cached_negative. Never the address in workEmailOf.
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { isAppError } from "@whytide/platform";
import { idOf } from "../readers.ts";
import { EMAIL_KINDS } from "./constants.ts";
import { needsConsent } from "./key.ts";
import { writeCache } from "./points.ts";
import { personalEmailEuUk } from "./switch.ts";

/**
 * The person's active, valid work address, else their usable personal one; null for none. Only the
 * email kinds are read: a phone is never an address (gamma-wr-100), whatever its columns hold.
 */
export async function workEmailOf(
  personId: string,
): Promise<{ contactPointId: string; verifiedAt: Date } | null> {
  const points = await tenantClient.contactPoint.findMany({
    where: {
      personId: idOf("personId", personId),
      kind: { in: [...EMAIL_KINDS] },
      status: "active",
      verification: "valid",
      verifiedAt: { not: null },
    },
    select: { id: true, kind: true, verifiedAt: true },
    orderBy: [{ verifiedAt: "desc" }, { id: "asc" }],
  });
  const point = points.find((found) => found.kind === "work_email") ?? points[0];
  // The table's CHECK keeps the date on an email row; a row without it is not answered.
  if (point === undefined || point.verifiedAt === null) return null;
  if (point.kind === "personal_email" && !(await personalUsable(personId))) return null;
  return { contactPointId: point.id, verifiedAt: point.verifiedAt };
}

/** The address of an active, valid email contact point an email may go to; null otherwise, for a phone too. */
export async function addressOf(contactPointId: string): Promise<string | null> {
  const point = await tenantClient.contactPoint.findFirst({
    where: {
      id: idOf("contactPointId", contactPointId),
      kind: { in: [...EMAIL_KINDS] },
      status: "active",
      verification: "valid",
    },
  });
  if (point === null) return null;
  if (point.kind === "personal_email" && !(await personalUsable(point.personId))) return null;
  return point.value;
}

/**
 * The contact point bounced: neither reader answers it again, and its key's email entry becomes a
 * negative one (`bounced`), so no later lookup gives it back. One gone already is no error.
 */
export async function markBounced(contactPointId: string, options: { at: Date }): Promise<void> {
  const { at } = options;
  // An address only: a phone does not bounce (gamma-wr-100).
  const point = await tenantClient.contactPoint.findFirst({
    where: { id: idOf("contactPointId", contactPointId), kind: { in: [...EMAIL_KINDS] } },
  });
  if (point === null) return;
  await tenantClient.contactPoint.update({
    where: { id: point.id },
    data: { status: "bounced", updatedAt: at },
  });
  const entries = await tenantClient.enrichmentCacheEntry.findMany({
    where: { kind: "email", value: point.value },
  });
  for (const { keyHash, personId, provider } of entries) {
    await writeCache({ kind: "negative", keyHash, personId, provider, at, reason: "bounced" });
  }
}

/** A personal address of the person needs no consent: the switch on, or a country off the list. */
async function personalUsable(personId: string): Promise<boolean> {
  try {
    const { locationCountry } = await getPerson(personId);
    return !needsConsent(locationCountry, personalEmailEuUk());
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return false;
    throw error;
  }
}
