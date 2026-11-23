// /email/callback, where the provider sends the browser back after the consent (README.md "Screen";
// docs/security.md): outside the workspaces, so the address the OAuth app lists stays fixed. Its URL
// carries the provider's code: proxy.ts sends it with Referrer-Policy: no-referrer, and callback.tsx
// removes it from the address before it posts.
import { PublicPage } from "@whytide/ui";
import { MailCheck } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";
import { Callback } from "./callback.tsx";

export default async function EmailCallback() {
  const t = await getTranslations("email.callback");
  return (
    <PublicPage panel icon={<MailCheck aria-hidden="true" />} title={t("title")}>
      <Callback />
    </PublicPage>
  );
}
