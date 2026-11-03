// The Company Knowledge screen (README "The screen"), a server component: the title, then the screen's
// client component, which reads the record in the browser, so that its loading and error states show,
// and holds the form that saves it.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { CompanyScreen } from "./company-screen.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function CompanyPage({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("onboarding.company");
  // The document's title too (axe's document-title): React hoists a <title> into the head, and the
  // generated page re-exports the screen's default only, so a generateMetadata would not reach Next.
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <CompanyScreen workspace={workspace} />
    </>
  );
}
