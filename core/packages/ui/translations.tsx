import { createContext, type ReactNode, useContext } from "react";

type Values = Record<string, string | number | Date>;
/** A translator of whole keys (`ui.action.save`) with `has`: next-intl's `useTranslations()`, say. */
export type TranslateFn = ((key: string, values?: Values) => string) & {
  has: (key: string) => boolean;
};

const Translations = createContext<TranslateFn | null>(null);

/** Gives the components their text: the host passes the translator of its message bundle. */
export function TranslationsProvider(props: { translate: TranslateFn; children: ReactNode }) {
  return <Translations value={props.translate}>{props.children}</Translations>;
}

function useTranslator(): TranslateFn {
  const translate = useContext(Translations);
  if (!translate) throw new Error("@whytide/ui: render the components inside TranslationsProvider");
  return translate;
}

/** `t(rest)` for the keys under `namespace`: next-intl's shape, which the message-key check reads. */
export function useTranslations(namespace: string): (key: string, values?: Values) => string {
  const translate = useTranslator();
  return (key, values) => translate(`${namespace}.${key}`, values);
}

/**
 * The text of an error code, by the contract of the platform's `translateError`: the module's
 * `<module>.errors.<code>`, else `platform.error.generic`. The key is composed on purpose, as there:
 * the check proves that every code a module registers has its key.
 */
export function useErrorText(module: string, code: string): string {
  const translate = useTranslator();
  const key = `${module}.errors.${code}`;
  return translate.has(key) ? translate(key) : translate("platform.error.generic");
}

/**
 * The text of a message key that arrives as data, a lead's why bullet `{ key, params }` say, with its
 * values; undefined when the bundle has no such key. Read at run time on purpose, as useErrorText
 * composes its key: the module that stores the key owns its message.
 */
export function useKeyText(): (key: string, values?: Values) => string | undefined {
  const translate = useTranslator();
  return (key, values) => (translate.has(key) ? translate(key, values) : undefined);
}
