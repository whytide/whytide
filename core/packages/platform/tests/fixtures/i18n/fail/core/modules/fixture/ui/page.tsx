// A fixture screen with a key no file defines, a key built at run time and a namespace the check
// cannot read.
import { getTranslations, useTranslations } from "next-intl";

export function Page({ column }: { column: string }) {
  const t = useTranslations();
  return (
    <main>
      <h1>{t("fixture.list.title")}</h1>
      <p>{t("fixture.list.broken", { name: "x" })}</p>
      <p>{t("fixture.list.stray")}</p>
      <p>{t("fixture.list")}</p>
      <p>{t("other.list.title")}</p>
      <p>{t("fixture.list.missing")}</p>
      <p>{t("fixture.invite.mail")}</p>
      <p>{t("fixture.invite.mail.subject")}</p>
      <p>{t(`fixture.list.${column}`)}</p>
    </main>
  );
}

export async function generateMetadata({ locale, ns }: { locale: string; ns: string }) {
  const t = await getTranslations({ locale, namespace: ns });
  return { title: t("title") };
}
