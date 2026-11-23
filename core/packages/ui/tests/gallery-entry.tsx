// The bundle the tests load (gallery-page.ts): the gallery under the provider a host gives, here a
// translator over flat messages through intl-messageformat, in the locale the spec names; the web
// host gives next-intl's instead.
import { IntlMessageFormat } from "intl-messageformat";
import { createRoot } from "react-dom/client";
import { Gallery } from "../dev/gallery.tsx";
import { type TranslateFn, TranslationsProvider } from "../index.ts";

export function render(messages: Record<string, string>, locale: string): void {
  const translate: TranslateFn = Object.assign(
    (key: string, values?: Record<string, string | number | Date>) => {
      const message = messages[key];
      if (message === undefined) throw new Error(`no message for ${key}`);
      return String(new IntlMessageFormat(message, locale).format(values));
    },
    { has: (key: string) => Object.hasOwn(messages, key) },
  );
  const root = document.getElementById("root");
  if (root) {
    createRoot(root).render(
      <TranslationsProvider translate={translate}>
        <Gallery />
      </TranslationsProvider>,
    );
  }
}
