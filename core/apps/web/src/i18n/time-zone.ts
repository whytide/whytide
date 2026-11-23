// The viewer's time zone as the server takes it from its cookie (README "The shell"; gamma-en-100):
// a name of the pattern that Intl knows, else none, and next-intl keeps the server's own zone. The
// cookie is the browser's to write, so nothing else in it reaches Intl.
import { TIME_ZONE_PATTERN } from "../../constants.ts";

/** The zone the cookie's value names, or undefined. */
export function timeZoneOf(value: string | undefined): string | undefined {
  if (value === undefined || !TIME_ZONE_PATTERN.test(value)) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}
