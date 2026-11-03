// The import screen, /w/{workspace}/import (README.md "The screen"), a server component: the title,
// then the screen's client component, which reads the past imports in the browser, so that their
// loading and error states show, and uploads, reports, runs and lists. React hoists the <title> into
// the head: the generated route re-exports the page alone, so a `metadata` export would not reach
// Next.js.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { ImportScreen } from "./import-screen.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function ImportPage({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("discovery.import");
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <ImportScreen workspace={workspace} />
    </>
  );
}
