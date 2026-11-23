// The AI disclosure line (README.md "The disclosure line"; gamma-p4-080; briefs RB-14.2.1,
// RB-20.6.1): fixed text from the message file, never generated, through the platform's translator;
// a text the campaign's mode approves ends with it, after a blank line, before its content freezes.
import {
  AppError,
  canonicalLocale,
  createTranslator,
  loadMessages,
  type Translator,
} from "@whytide/platform";
import { errors } from "../../errors.ts";
import { DISCLOSURE_CHANNELS, type DisclosureChannel } from "../../schemas/writer.ts";
import { DISCLOSURE_KEYS, DISCLOSURE_SEPARATOR } from "./constants.ts";

/** One translator per locale asked: the bundle is read from the message files once. */
const translators = new Map<string, Translator>();

/** A channel with a line: a LinkedIn message or an email. */
export const isDisclosureChannel = (channel: string): channel is DisclosureChannel =>
  (DISCLOSURE_CHANNELS as readonly string[]).includes(channel);

/**
 * The channel's line in the locale, whose messages fall back to the default locale's file:
 * messaging_input_invalid (`details.fields`) for any channel but a LinkedIn message or an email, a
 * connection request's note included; the platform's invalid_locale for a tag that is none.
 */
export function disclosureLine(channel: DisclosureChannel, locale: string): string {
  if (!isDisclosureChannel(channel)) {
    throw new AppError(errors.messaging_input_invalid, { details: { fields: ["channel"] } });
  }
  const tag = canonicalLocale(locale);
  let translate = translators.get(tag);
  if (translate === undefined) {
    translate = createTranslator(loadMessages(tag), tag);
    translators.set(tag, translate);
  }
  return translate(DISCLOSURE_KEYS[channel]).trim();
}

/** The text, a blank line and the channel's line in the locale. */
export function withDisclosure(text: string, channel: DisclosureChannel, locale: string): string {
  return `${text}${DISCLOSURE_SEPARATOR}${disclosureLine(channel, locale)}`;
}
