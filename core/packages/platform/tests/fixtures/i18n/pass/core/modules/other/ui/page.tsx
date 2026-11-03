// A second fixture module, so the bundle merges more than one file; a one-segment namespace.
import { useTranslations } from "next-intl";

export function OtherTitle() {
  const t = useTranslations("other");
  return <h1>{t("list.title")}</h1>;
}
