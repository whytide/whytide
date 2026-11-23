// The 30-day rule (README.md "The 30-day rule"; RB-20.2.3 and RB-20.4.3, reduced): which persons of a
// workspace its job deletes. The clock is the person's created_at, which contacts sets once and no
// refresh, re-import or re-enrichment moves (data model §2.7). Pure: the workflow's sandbox imports
// the cutoff too.
import {
  MS_PER_DAY,
  RETENTION_EU_UK_COUNTRIES,
  RETENTION_NEVER_CONTACTED_DAYS,
} from "./constants.ts";

/** What the rule reads of a person, as contacts' listPersons answers one. */
export type FoundPerson = {
  readonly createdAt: Date;
  /** The latest outbound touch; null before the first. Unread, the person is no candidate. */
  readonly lastTouchAt?: Date | null;
  /** ISO 3166-1 alpha-2, as contacts reads it from the location; null when none. */
  readonly locationCountry: string | null;
};

/** A country as contacts writes one: two capital letters. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/** A run's cutoff: its instant less RETENTION_NEVER_CONTACTED_DAYS days. */
export function cutoffOf(at: Date): Date {
  return new Date(at.getTime() - RETENTION_NEVER_CONTACTED_DAYS * MS_PER_DAY);
}

/**
 * A candidate: no invite, message or email ever went to the person (`last_touch_at` null), found at
 * or before the cutoff, and located in RETENTION_EU_UK_COUNTRIES or nowhere known: no country, or a
 * value that is no two-letter code.
 */
export function isCandidate(person: FoundPerson, cutoff: Date): boolean {
  if (person.lastTouchAt !== null) return false;
  if (person.createdAt.getTime() > cutoff.getTime()) return false;
  const country = person.locationCountry;
  return country === null || !COUNTRY_CODE.test(country) || RETENTION_EU_UK_COUNTRIES.has(country);
}
