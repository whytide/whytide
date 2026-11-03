// A fixture screen: a whole key, the namespace form next-intl uses (`useTranslations("ns")` +
// `t("rest")`), and the options form of `getTranslations` that generateMetadata takes.
import { getTranslations, useTranslations } from "next-intl";

export function ListTitle() {
  const t = useTranslations();
  return <h1>{t("fixture.list.title")}</h1>;
}

export function ListCount({ count }: { count: number }) {
  const t = useTranslations("fixture.list");
  return <p>{t("count", { count })}</p>;
}

export async function generateMetadata({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "fixture.list" });
  return { title: t("title") };
}
