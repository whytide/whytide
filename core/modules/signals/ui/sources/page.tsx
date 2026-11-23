// The sources screen (README.md "Screen"), a server component: the title and the header; sources.tsx
// reads the workspace's sources and linkedin's sender accounts in the browser, with the screen's
// states, and opens the runs panel of the source `?runs=<id>` names; imported-files.tsx, below them,
// reads discovery's imports and signals' imports of sources. The accounts and the imports come
// through the web's API client: signals never imports the linkedin or discovery module.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { SourcesAndFiles } from "./sources.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Sources({ params, searchParams }: Props) {
  const { workspace } = await params;
  const { runs } = await searchParams;
  const t = await getTranslations("signals");
  // The document's title too (axe's document-title): React hoists it into the head, as the route
  // the web generates re-exports the page alone, never its metadata.
  return (
    <>
      <title>{t("sources.title")}</title>
      <PageHeader title={t("sources.title")} description={t("sources.description")} />
      <SourcesAndFiles
        workspaceId={workspace}
        runsOf={typeof runs === "string" ? runs : undefined}
      />
    </>
  );
}
