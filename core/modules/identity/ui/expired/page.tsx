// /sign-in/expired: where a link that is unknown, used, expired or refused since lands
// (AUTH_LINK_FAILED_PATH, `?code=auth_link_expired`), with the way back to ask for a new one.
import { ButtonLink, PublicPage } from "@whytide/ui";
import { TimerOff } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";

export default async function SignInExpired() {
  const t = await getTranslations("identity.sign_in.expired");
  return (
    <PublicPage
      panel
      icon={<TimerOff aria-hidden="true" />}
      title={t("title")}
      description={t("body")}
    >
      <ButtonLink href="/sign-in" variant="primary">
        {t("retry")}
      </ButtonLink>
    </PublicPage>
  );
}
