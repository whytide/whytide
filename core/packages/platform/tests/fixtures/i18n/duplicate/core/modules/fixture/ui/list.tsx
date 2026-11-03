// The screen that uses the key both files define.
import { useTranslations } from "next-intl";

export function ListTitle() {
  const t = useTranslations();
  return <h1>{t("fixture.list.title")}</h1>;
}
