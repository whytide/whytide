// /sign-in/sent: the same page after any email, invited or not, so that it reveals nothing.
import { Link, PublicPage } from "@whytide/ui";
import { MailCheck } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";

export default async function SignInSent() {
  const t = await getTranslations("identity.sign_in.sent");
  return (
    <PublicPage
      panel
      icon={<MailCheck aria-hidden="true" />}
      title={t("title")}
      description={t("body")}
    >
      <p>
        <Link href="/sign-in">{t("back")}</Link>
      </p>
    </PublicPage>
  );
}
