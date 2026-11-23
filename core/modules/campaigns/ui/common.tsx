// What the campaigns' two screens share (README.md "Screens"): a campaign's status on its badge, one
// t() call per status written out so that the message check reads every key; its name, the seeded
// campaign's own words while its name is empty; and its current version.
import { Badge } from "@whytide/ui";
import { useTranslations } from "next-intl";
import type { CampaignStatus } from "../domain/campaigns/constants.ts";
import { STATUS_TONES } from "./constants.ts";

export function StatusBadge({ status }: { status: CampaignStatus }) {
  const t = useTranslations("campaigns.list.status");
  const words: Record<CampaignStatus, string> = {
    draft: t("draft"),
    active: t("active"),
    paused: t("paused"),
    completed: t("completed"),
    archived: t("archived"),
  };
  return <Badge tone={STATUS_TONES[status]}>{words[status]}</Badge>;
}

/** A campaign's name, the seeded one's words for its empty name, and its version in words. */
export function useCampaignText() {
  const t = useTranslations("campaigns.list");
  return {
    name: (name: string) => name || t("default_name"),
    version: (versionNo: number | null) =>
      versionNo === null ? t("no_version") : t("version", { version: versionNo }),
  };
}
