// A number by form only (README "A person's phone"; gamma-wr-100): what a page printed, cleaned to its
// digits with a leading `+` when the page printed one, 7 to 15 digits; whether two printed numbers
// are one number; the address of the page it came from. No dictionary of countries, no new dependency:
// the number is never dialled, only shown. Pure.
import {
  PHONE_DIGITS_MAX,
  PHONE_DIGITS_MIN,
  PHONE_PAGE_MAX,
  PHONE_PRINTED,
  PHONE_PRINTED_MAX,
  PHONE_TRUNK_ZERO,
} from "./constants.ts";

/** The digits of a text, in order. */
export const digitsOf = (text: string): string => text.replace(/\D/gu, "");

/**
 * The number as it is kept: its digits, with a leading `+` when the page printed one, and without a
 * trunk zero printed in parentheses (`+49 (0)30 1234` and `+49 30 1234` are one number). Null for a
 * text with a character a number does not hold (a letter, an extension, a second `+`), or with fewer
 * than PHONE_DIGITS_MIN or more than PHONE_DIGITS_MAX digits.
 */
export function cleanPhone(printed: string): string | null {
  const text = printed.trim();
  if (text.length === 0 || text.length > PHONE_PRINTED_MAX || !PHONE_PRINTED.test(text))
    return null;
  const digits = digitsOf(text.replace(PHONE_TRUNK_ZERO, ""));
  if (digits.length < PHONE_DIGITS_MIN || digits.length > PHONE_DIGITS_MAX) return null;
  return `${text.startsWith("+") ? "+" : ""}${digits}`;
}

/**
 * A number's digits without a trunk zero printed in parentheses after a country code, `+49 (0)30`,
 * and without the leading zeros of a trunk or an international prefix.
 */
export const significant = (number: string): string =>
  digitsOf(number.replace(PHONE_TRUNK_ZERO, "")).replace(/^0+/u, "");

/**
 * Whether two printed numbers are one: the same digits, or one is the other without its country
 * code (a national and an international way of printing it), the shorter holding at least
 * PHONE_DIGITS_MIN digits.
 */
export function samePhone(a: string, b: string): boolean {
  const [first, second] = [significant(a), significant(b)];
  const [short, long] = first.length <= second.length ? [first, second] : [second, first];
  return short.length >= PHONE_DIGITS_MIN && long.endsWith(short);
}

/**
 * The address of the page a number came from: an http or https page, without its query, fragment and
 * credentials; null for any other address (a `javascript:` one, a file) or one that is too long.
 */
export function pageOfPhone(address: string): string | null {
  const url = URL.parse(address);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const page = `${url.origin}${url.pathname}`;
  return page.length > PHONE_PAGE_MAX ? null : page;
}
