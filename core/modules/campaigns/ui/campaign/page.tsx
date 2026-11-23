// The campaign's page, /w/{workspace}/campaigns/{campaignId} (README.md "Screens"), a server
// component: the campaign with its current version's steps, then, through the api as the member,
// credits' price list, whose LinkedIn send every LinkedIn step and the launch panel show, the first
// leads by fit, the previews' sample (contacts' GET …/leads), and a draft's launch checks, which
// campaign.tsx, a client component, shows and changes. A campaign the workspace does not hold is the
// page's not-found state, and nothing more is read. Who is signed in (GET /v1/me) says whether the
// member may change the campaign: its owner, or a holder of campaigns.manage (README.md "Decided
// here"); and its approval mode, a holder of campaigns.approval_mode (gamma-p4-070), whose card
// shows the `disclosure` slot's panels, messaging's AI disclosure line, once per channel.
import { ButtonLink, EmptyState, PageHeader } from "@whytide/ui";
import { ArrowLeft } from "@whytide/ui/icons";
import { data, serverApi } from "@whytide/web/api/server";
import { getTranslations } from "next-intl/server";
import type { ComponentType } from "react";
import { APPROVAL_MODE_ROLES } from "../../domain/approval-mode/constants.ts";
import { CAMPAIGNS_MANAGE_ROLES } from "../../domain/campaigns/constants.ts";
import { LINKEDIN_SEND_ACTION } from "../../domain/send/constants.ts";
import { ApprovalModePicker } from "../approval-mode/picker.tsx";
import {
  CAMPAIGN_PATH,
  campaignsScreen,
  DISCLOSURE_CHANNELS,
  LAUNCH_CHECKS_PATH,
  LEADS_PATH,
  PRICES_PATH,
  SAMPLE_LEADS,
  SAMPLE_SORT,
} from "../constants.ts";
import { Campaign } from "./campaign.tsx";
import type { CampaignSlot, PanelProps } from "./slots.ts";

type Props = {
  params: Promise<{ workspace: string; campaignId: string }>;
  panels: Partial<Record<CampaignSlot, readonly ComponentType<PanelProps>[]>>;
};

export default async function CampaignPage({ params, panels }: Props) {
  const { workspace, campaignId } = await params;
  const api = await serverApi();
  const path = { workspaceId: workspace };
  const own = { path: { ...path, campaignId } };
  const read = await api.GET(CAMPAIGN_PATH, { params: own });
  if (read.response.status === 404) return <CampaignNotFound workspace={workspace} />;
  const campaign = await data(Promise.resolve(read));
  const query = { sort: SAMPLE_SORT, limit: SAMPLE_LEADS } as const;
  const [{ prices }, { leads }, launch, me] = await Promise.all([
    data(api.GET(PRICES_PATH, { params: { path } })),
    data(api.GET(LEADS_PATH, { params: { path, query } })),
    campaign.status === "draft" ? data(api.GET(LAUNCH_CHECKS_PATH, { params: own })) : undefined,
    data(api.GET("/v1/me")),
  ]);
  const role = me.memberships.find(
    ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
  )?.role;
  const writable =
    CAMPAIGNS_MANAGE_ROLES.some((manager) => manager === role) ||
    campaign.ownerUserId === me.user.id;
  const disclosure = panels.disclosure ?? [];
  const lines = DISCLOSURE_CHANNELS.flatMap((channel) =>
    disclosure.map((Panel, index) => <Panel key={`${channel}-${index}`} channel={channel} />),
  );
  const mode = (
    <ApprovalModePicker
      workspace={workspace}
      campaignId={campaign.id}
      initial={campaign.approvalMode}
      locked={Date.parse(campaign.approvalMode.lockedUntil) > Date.now()}
      lines={lines}
      writable={APPROVAL_MODE_ROLES.some((holder) => holder === role)}
    />
  );
  const price = prices.find(({ action }) => action === LINKEDIN_SEND_ACTION);
  const sample = leads.map(({ personId, person }) => ({
    personId,
    firstName: person.firstName,
    lastName: person.lastName,
  }));
  return (
    <Campaign
      workspace={workspace}
      initial={campaign}
      price={price}
      leads={sample}
      checks={launch?.checks}
      writable={writable}
      mode={mode}
    />
  );
}

/** Another workspace's campaign, or none: a heading, why, and the way back to the list. */
async function CampaignNotFound({ workspace }: { workspace: string }) {
  const t = await getTranslations("campaigns");
  return (
    <>
      <title>{t("editor.not_found")}</title>
      <PageHeader title={t("editor.not_found")} />
      <EmptyState
        message={t("errors.campaign_not_found")}
        action={
          <div>
            <ButtonLink href={campaignsScreen(workspace)}>
              <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
              {t("editor.back")}
            </ButtonLink>
          </div>
        }
      />
    </>
  );
}
