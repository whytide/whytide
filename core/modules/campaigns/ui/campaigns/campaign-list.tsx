"use client";
// The list of campaigns (README.md "Screens"): the kit's DataTable of the workspace's campaigns in the
// api's order, oldest first, each name the link to its page, the seeded one's in words; its status,
// its current version and its launch date in the reader's locale; the empty state while there is
// none, which only a workspace without an Owner, so without the seeded campaign, sees.
import { type Column, DataTable, EmptyState } from "@whytide/ui";
import { useFormatter, useTranslations } from "next-intl";
import type { CampaignsResponse } from "../../schemas/campaigns.ts";
import { StatusBadge, useCampaignText } from "../common.tsx";
import { campaignScreen, DATE_FORMAT } from "../constants.ts";

type Listed = CampaignsResponse["campaigns"][number];
type Props = { workspace: string; campaigns: Listed[] };

export function CampaignList({ workspace, campaigns }: Props) {
  const t = useTranslations("campaigns.list");
  const format = useFormatter();
  const text = useCampaignText();
  const launched = ({ launchedAt }: Listed) =>
    launchedAt === null ? t("not_launched") : format.dateTime(new Date(launchedAt), DATE_FORMAT);
  const columns: Column<Listed>[] = [
    { id: "name", header: t("column_name"), cell: (campaign) => text.name(campaign.name) },
    {
      id: "status",
      header: t("column_status"),
      cell: (campaign) => <StatusBadge status={campaign.status} />,
    },
    {
      id: "version",
      header: t("column_version"),
      cell: (campaign) => text.version(campaign.versionNo),
    },
    { id: "launched", header: t("column_launched"), cell: launched },
  ];
  return (
    <DataTable
      caption={t("caption")}
      columns={columns}
      rows={campaigns}
      rowHref={(campaign) => campaignScreen(workspace, campaign.id)}
      empty={<EmptyState message={t("empty")} />}
    />
  );
}
