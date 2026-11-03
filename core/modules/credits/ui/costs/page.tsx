// The costs page (README.md "Screens"), /w/{ws}/credits, a server component: the title and the
// header; costs.tsx reads the balance, the week's costs and its usage in the browser, with the
// screen's states and the week picker.
import { PageHeader } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { CostsScreen } from "./costs.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function Costs({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("credits.screen");
  // The document's title too (axe's document-title), as signals' sources page sets it.
  return (
    <>
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <CostsScreen workspaceId={workspace} />
    </>
  );
}
