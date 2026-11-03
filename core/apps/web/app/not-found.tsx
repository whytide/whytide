// Any URL no route takes, /w/{workspace}/nope among them, and a screen that calls notFound().
import { ButtonLink, PublicPage } from "@whytide/ui";
import { ArrowLeft, Compass } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
  const t = await getTranslations("web.not_found");
  return (
    <PublicPage icon={<Compass aria-hidden="true" />} title={t("title")} description={t("body")}>
      <div>
        <ButtonLink href="/" variant="primary">
          <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
          {t("home")}
        </ButtonLink>
      </div>
    </PublicPage>
  );
}
