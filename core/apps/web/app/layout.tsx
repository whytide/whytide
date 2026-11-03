// The root of every page: the one stylesheet (globals.css), the theme the person chose, from its
// cookie, so the server renders it with no flash (@whytide/ui/theme), and the bundle's messages for
// next-intl and for the components. Each page renders per request, so that Next.js marks its scripts
// with the nonce of the request's content security policy (proxy.ts).
import "./globals.css";
import { THEME_COOKIE, themeAttribute, themeOf } from "@whytide/ui/theme";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { Translations } from "../src/shell/translations.tsx";

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const theme = themeOf((await cookies()).get(THEME_COOKIE)?.value);
  // scroll-pb-24: on a phone, where the page scrolls, a field brought into view stays clear of a
  // screen's sticky save bar (the workspace's panel does the same from lg).
  return (
    <html lang={await getLocale()} data-theme={themeAttribute(theme)} className="scroll-pb-24">
      <body>
        <NextIntlClientProvider>
          <Translations>{children}</Translations>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
