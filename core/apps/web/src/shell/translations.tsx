// @whytide/ui's components take their text from next-intl's translator of the whole bundle, which
// only a client component holds: the root layout renders this one inside NextIntlClientProvider.
"use client";

import { type TranslateFn, TranslationsProvider } from "@whytide/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export function Translations({ children }: { children: ReactNode }) {
  const translate = useTranslations();
  return (
    <TranslationsProvider translate={translate as TranslateFn}>{children}</TranslationsProvider>
  );
}
