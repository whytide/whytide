// The Companies found screen (README.md "Screen"; gamma-wr-111), a server component: the title and the
// header; found-companies.tsx reads the workspace's found companies and its sources in the browser,
// with the screen's states. `?source=`, `?agent=` and `?verdict=` open it on a view: the sources' card
// and the agent's panel link here.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { VERDICTS } from "../../domain/research/constants.ts";
import { FoundCompanies } from "./found-companies.tsx";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CompaniesFound({ params, searchParams }: Props) {
  const { workspace } = await params;
  const { source, agent, verdict } = await searchParams;
  const t = await getTranslations("signals");
  const text = (value: string | string[] | undefined) =>
    typeof value === "string" ? value : undefined;
  const chosen = VERDICTS.find((known) => known === verdict);
  // The document's title too (axe's document-title): React hoists it into the head, as the route
  // the web generates re-exports the page alone, never its metadata.
  return (
    <>
      <title>{t("found.title")}</title>
      <PageHeader title={t("found.title")} description={t("found.description")} />
      <FoundCompanies
        workspaceId={workspace}
        initial={{ source: text(source), agent: text(agent), verdict: chosen }}
      />
    </>
  );
}
