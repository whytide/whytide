// A person's phone: its names and bounds (README "A person's phone"). Pure: signals' people step
// imports it through form.ts, so it holds no registry.

/** A number holds this many digits at least, and at most (the form's bounds). */
export const PHONE_DIGITS_MIN = 7;
export const PHONE_DIGITS_MAX = 15;
/** A printed number is this long at most, spaces and separators included. */
export const PHONE_PRINTED_MAX = 40;
/** What a printed number may hold: digits, spaces, `.`, `-`, parentheses, and a `+` before them. */
export const PHONE_PRINTED = /^\+?[\d\s().-]+$/u;
/** A trunk zero printed in parentheses after a country code, `+49 (0)30`: not dialled from abroad, so not part of the number. */
export const PHONE_TRUNK_ZERO = /\(\s*0\s*\)/gu;
/** The contact point's class and provider of a number a public page printed with the person. */
export const PHONE_SOURCE_CLASS = "web_page";
export const PHONE_PROVIDER = "research";
/** The page's address is kept up to this long (contacts' lead url bound). */
export const PHONE_PAGE_MAX = 2048;
