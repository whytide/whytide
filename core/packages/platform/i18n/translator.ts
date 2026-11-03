import { AppError } from "../errors/index.ts";
import { errors } from "./errors.ts";
import { formatIcu, type MessageValues } from "./icu.ts";
import { canonicalLocale } from "./locale.ts";
import type { Messages } from "./messages.ts";

/** What `translateError` needs of a translator; next-intl's `t` in a screen has the same shape. */
export type TranslateFn = ((key: string, values?: MessageValues) => string) & {
  readonly has: (key: string) => boolean;
};

/** `t(key, values)` for server code (mail, jobs); screens get next-intl's `t` in the web host, over the same bundle. */
export type Translator = TranslateFn & { readonly locale: string };

/** The message at a dotted key of a nested bundle, or undefined; own keys only, whatever the bundle's prototype. */
export function lookup(messages: Messages, key: string): string | undefined {
  let node: Messages | string | undefined = messages;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || !Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return typeof node === "string" ? node : undefined;
}

export function createTranslator(messages: Messages, locale: string): Translator {
  const tag = canonicalLocale(locale);
  const translate = (key: string, values: MessageValues = {}): string => {
    const value = lookup(messages, key);
    if (value === undefined) {
      throw new AppError(errors.message_not_found, { details: { key, locale: tag } });
    }
    return formatIcu(value, values, tag);
  };
  const has = (key: string) => lookup(messages, key) !== undefined;
  return Object.assign(translate, { has, locale: tag });
}

/** The message key of a module's error code, `<module>.errors.<code>`: API errors stay machine codes, the UI translates them (coding §4). */
export function errorMessageKey(module: string, code: string): string {
  return `${module}.errors.${code}`;
}

/** The text for an error code: the module's message, or the platform's generic one when the module has none for it. */
export function translateError(
  t: TranslateFn,
  module: string,
  code: string,
  values?: MessageValues,
): string {
  const key = errorMessageKey(module, code);
  return t.has(key) ? t(key, values) : t("platform.error.generic");
}
