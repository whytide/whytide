import { useTranslations } from "next-intl";

export default function List() {
  const t = useTranslations("a.list");
  return <h1 title={t("missing")}>{t("title")}</h1>;
}
