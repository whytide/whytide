import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";
import type { MessageValues } from "./icu.ts";
import { loadMessages, type Messages } from "./messages.ts";
import { createTranslator } from "./translator.ts";

export type Mail = { readonly subject: string; readonly body: string };

export type MailOptions = {
  /** The bundle to render from; the locale's bundle, read from the repository, when unset. */
  readonly messages?: Messages;
  readonly root?: string;
};

const PARTS = ["subject", "body"] as const;

/**
 * A mail from the keys `<key>.subject` and `<key>.body` through ICU, for the locale: the sign-in
 * link, invites, alerts. In development every mail goes to Mailpit (coding §8).
 */
export function renderMail(
  key: string,
  params: MessageValues,
  locale: string,
  options: MailOptions = {},
): Mail {
  const messages = options.messages ?? loadMessages(locale, { root: options.root });
  const translate = createTranslator(messages, locale);
  for (const part of PARTS) {
    if (!translate.has(`${key}.${part}`)) {
      throw new AppError(errors.message_not_found, {
        details: { key: `${key}.${part}`, mail: key },
      });
    }
  }
  return { subject: translate(`${key}.subject`, params), body: translate(`${key}.body`, params) };
}
