// The bounds of the addresses a person gave (README.md "Addresses a person gave", gamma-en-085),
// beside their reader, given.ts. Pure.

/**
 * The channels whose threads the reader reads: LinkedIn's only. An email reply quotes the thread
 * ("… <sender@ourco> wrote:"), so gamma-p4-020 drops quoted text before it adds `email` here.
 */
export const GIVEN_CHANNELS = ["linkedin"] as const;
/** The person's newest inbound messages holding an address that the reader answers, at most. */
export const GIVEN_MESSAGES = 5;
/** The newest inbound messages holding an `@` it reads to find them, at most. */
export const GIVEN_SCAN = 50;
/** An address's local part and its domain, in characters, at most (RFC 5321). */
export const LOCAL_MAX = 64;
export const DOMAIN_MAX = 253;
/** The addresses one message gives at most. */
export const PER_MESSAGE = 10;
/** A local part's characters and a domain's, as an address in a text is read. */
export const LOCAL_CHAR = /[a-z0-9._%+-]/i;
export const DOMAIN_CHAR = /[a-z0-9.-]/i;
/** An address as kept: a dotted local part, a domain of labels with a top-level one of letters. */
export const ADDRESS =
  /^[a-z0-9%+_-]+(?:\.[a-z0-9%+_-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
