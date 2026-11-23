// The alerts port's text rule (README.md "The method and the codes").

/**
 * The longest text, in characters as JavaScript counts them (UTF-16 code units, so never more code
 * points): Discord's limit for one message, the smallest of the three channels' (not in the sources).
 */
export const ALERT_TEXT_MAX = 2000;

/** A text's characters: any but a control character (Unicode's Cc), the newline aside. */
export const ALERT_TEXT = /^(?:[^\p{Cc}]|\n)*$/u;
