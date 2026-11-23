// "Campaigns" (README.md "Screens"), /w/{ws}/campaigns, a server component: the <title> and the
// header, then the workspace's campaigns, read through the api as the member (GET …/campaigns, which
// makes the seeded campaign on first use), in the list (campaign-list.tsx), a client component.
import { PageHeader } from "@whytide/ui";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import { CAMPAIGNS_PATH } from "../constants.ts";
import { CampaignList } from "./campaign-list.tsx";

type Props = { params: Promise<{ workspace: string }> };

export default async function Campaigns({ params }: Props) {
  const { workspace } = await params;
  const t = await getTranslations("campaigns.list");
  const api = await serverApi();
  const request = { params: { path: { workspaceId: workspace } } };
  const { campaigns } = await data(api.GET(CAMPAIGNS_PATH, request));
  return (
    <>
      {/* The document's title too (axe's document-title): React hoists it into the head. */}
      <title>{t("title")}</title>
      <PageHeader title={t("title")} description={t("description")} />
      <CampaignList workspace={workspace} campaigns={campaigns} />
    </>
  );
}
