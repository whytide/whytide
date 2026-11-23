// What a research step hands to a model or keeps of a text: cut to a bound, never inside a character,
// and the member's free text scrubbed (a link, an email address and a phone number become the
// placeholders of the rating's scrub). Pure.
import { scrub } from "../rate/scrub.ts";

/** The text cut to `max` characters, never inside a character. */
export const fit = (value: string, max: number): string => [...value].slice(0, max).join("");

/** The text scrubbed, then cut to `max` characters. */
export const clean = (value: string, max: number): string => fit(scrub(value, "") ?? "", max);
