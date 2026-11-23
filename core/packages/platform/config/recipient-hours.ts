// The lead's zone and the window an email goes in (README "Time"; F11 §5.1; briefs RB-1.2.5,
// RB-12.2.1), pure: a country and a location text in, an IANA zone or null out; that zone or null
// and the sender's schedule in, the schedule a send must fall in out. Unknown is safe: the sender's
// hours are the brief's fallback, and no zone is guessed from a city's name.
import {
  LOCATION_PART_SEPARATOR,
  PLACE_NAME_STEPS,
  RECIPIENT_BUSINESS_HOURS,
} from "./constants.ts";
import { COUNTRY_TIME_ZONES, REGION_TIME_ZONES } from "./country-zones.ts";
import { timeArgumentInvalid } from "./errors.ts";
import { isTimeZone, type LocalSchedule, localSchedule } from "./time.ts";

/** A lead's location, the person's or their company's headquarters, asked one at a time. */
export type LeadLocation = {
  /** ISO 3166-1 alpha-2, as contacts' countryOf writes it (`persons.location_country`). */
  readonly country?: string | null;
  /** The location as written: "San Francisco, California, United States". */
  readonly locationText?: string | null;
};

export type SendWindowInput = {
  /** The recipient's zone, as timeZoneOf answers it: null when unknown. */
  readonly recipientZone: string | null;
  /** The sender's own schedule: the fallback. */
  readonly sender: LocalSchedule;
};

/** The schedule a send must fall in, and whose hours it keeps, for the step's record. */
export type SendWindow = {
  readonly used: "recipient" | "sender";
  readonly schedule: LocalSchedule;
};

// Maps from the frozen tables, read once: a name never reaches Object's prototype.
const countryZones: ReadonlyMap<string, string> = new Map(Object.entries(COUNTRY_TIME_ZONES));
const regionZones: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Object.entries(REGION_TIME_ZONES).map(([country, regions]) => {
    const pair = (zone: string) => (name: string) => [nameKey(name), zone] as const;
    return [country, new Map(regions.flatMap(({ names, zone }) => names.map(pair(zone))))];
  }),
);

/**
 * The lead's IANA zone, or null when it is unknown. A country of COUNTRY_TIME_ZONES answers its
 * zone. The United States, Canada and Australia answer the zone of the state, province or
 * territory that one of the text's comma-separated parts names, read from the last, so
 * "Washington, District of Columbia" is the District's; a text that names none answers null. Any
 * other country, or none, answers null.
 */
export function timeZoneOf(location: LeadLocation): string | null {
  const { country, locationText } = location;
  if (!country) return null;
  const zone = countryZones.get(country);
  if (zone !== undefined) return zone;
  const regions = regionZones.get(country);
  if (regions === undefined || !locationText) return null;
  const parts = locationText.split(LOCATION_PART_SEPARATOR).map(nameKey);
  const named = parts.findLast((part) => regions.has(part));
  return named === undefined ? null : (regions.get(named) ?? null);
}

/**
 * The schedule a send must fall in: RECIPIENT_BUSINESS_HOURS in the recipient's zone when it is
 * known, the sender's schedule when it is null, `used` saying which. A zone isTimeZone refuses, or
 * a schedule localSchedule refuses, throws time_argument_invalid.
 */
export function sendWindowFor(input: SendWindowInput): SendWindow {
  const { recipientZone, sender } = input;
  const parsed = localSchedule.safeParse(sender);
  if (!parsed.success) throw timeArgumentInvalid("sender");
  if (recipientZone === null) return { used: "sender", schedule: parsed.data };
  // isTimeZone takes the zone as text: undefined would read as "undefined", which Intl accepts.
  if (typeof recipientZone !== "string" || !isTimeZone(recipientZone)) {
    throw timeArgumentInvalid("recipientZone");
  }
  const { start, end, days } = RECIPIENT_BUSINESS_HOURS;
  return { used: "recipient", schedule: { timeZone: recipientZone, start, end, days: [...days] } };
}

function nameKey(text: string): string {
  const folded = text.normalize("NFD").toLowerCase();
  return PLACE_NAME_STEPS.reduce((key, [pattern, by]) => key.replace(pattern, by), folded).trim();
}
