// The shared words of packages/ui are messages too; that package is scanned whole.
import { useTranslations } from "next-intl";

export function SaveButton() {
  const t = useTranslations();
  return <button type="submit">{t("ui.actions.save")}</button>;
}
