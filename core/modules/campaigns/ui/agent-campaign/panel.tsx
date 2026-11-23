// campaigns' panel in the campaign slot of playbooks' agent page (ui/nav.ts `panels`; README.md
// "Screens"; gamma-p3-065): the agent's campaign, read in the browser as the member through
// campaigns' own routes, the list filtered by the agent, then the campaign with its current
// version's steps. Its name, status, version and launch date; its steps, read only; for an active
// campaign Pause, which asks first in the kit's Dialog, for a paused one Resume (gamma-p3-061's
// routes); and the way to the campaign's page, where its sequence is edited and it is launched.
// While it reads, the slot's loading state; a failed read, the error state with the code in words
// and Try again; no campaign yet, as before the worker made it, the empty state. A refused pause or
// resume shows its code in words and reads the campaign again, which may have moved meanwhile. Who
// is signed in (GET /v1/me) says whether the member may pause and resume it: its owner, or a holder
// of campaigns.manage (gamma-p6-015); anyone else gets the hint in their place.
"use client";

import {
  Button,
  ButtonLink,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@whytide/ui";
import { Pause, Play } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { CAMPAIGNS_MANAGE_ROLES, FALLBACK_CONDITION } from "../../domain/campaigns/constants.ts";
import type { CampaignResponse } from "../../schemas/campaigns.ts";
import { useCampaignWords } from "../campaign/words.ts";
import { StatusBadge, useCampaignText } from "../common.tsx";
import {
  CAMPAIGN_PATH,
  CAMPAIGNS_PATH,
  campaignScreen,
  PAUSE_PATH,
  RESUME_PATH,
} from "../constants.ts";

type Read =
  | { readonly campaign: CampaignResponse | null; readonly writable: boolean }
  | { readonly failed: string };
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export default function AgentCampaignPanel(props: { workspace: string; playbookId: string }) {
  const { workspace, playbookId } = props;
  const t = useTranslations("campaigns.agent_panel");
  const [read, setRead] = useState<Read>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (): Promise<Read> => {
    const path = { workspaceId: workspace };
    const query = { playbookId };
    const [{ campaigns }, me] = await Promise.all([
      data(browserApi().GET(CAMPAIGNS_PATH, { params: { path, query } })),
      data(browserApi().GET("/v1/me")),
    ]);
    const [listed] = campaigns;
    if (listed === undefined) return { campaign: null, writable: false };
    const params = { path: { ...path, campaignId: listed.id } };
    const campaign = await data(browserApi().GET(CAMPAIGN_PATH, { params }));
    const role = me.memberships.find(
      ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
    )?.role;
    const writable =
      CAMPAIGNS_MANAGE_ROLES.some((manager) => manager === role) ||
      campaign.ownerUserId === me.user.id;
    return { campaign, writable };
  }, [workspace, playbookId]);

  // One read per agent, workspace and attempt; an earlier one that answers late is dropped.
  useEffect(() => {
    let live = true;
    setRead(undefined);
    load().then(
      (answer) => live && setRead(answer),
      (error: unknown) => live && setRead({ failed: codeOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);

  /** After a refused pause or resume: the campaign read again in place. */
  const reload = () => load().then(setRead, (error: unknown) => setRead({ failed: codeOf(error) }));

  if (read === undefined) return <LoadingState />;
  return (
    <Card title={t("title")}>
      {"failed" in read ? (
        <ErrorState
          module="campaigns"
          code={read.failed}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : read.campaign === null ? (
        <EmptyState message={t("empty")} />
      ) : (
        <AgentCampaign
          workspace={workspace}
          campaign={read.campaign}
          writable={read.writable}
          onChanged={(campaign) => setRead({ campaign, writable: read.writable })}
          onStale={reload}
        />
      )}
    </Card>
  );
}

/** The campaign's line, its steps, Pause or Resume for its writer, and the way to its page. */
function AgentCampaign(props: {
  workspace: string;
  campaign: CampaignResponse;
  writable: boolean;
  onChanged: (campaign: CampaignResponse) => void;
  onStale: () => Promise<unknown>;
}) {
  const { workspace, campaign, writable, onChanged, onStale } = props;
  const t = useTranslations("campaigns.agent_panel");
  const editor = useTranslations("campaigns.editor");
  const text = useCampaignText();
  const words = useCampaignWords();
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [failure, setFailure] = useState<string>();
  const active = campaign.status === "active";

  async function move(to: "pause" | "resume") {
    setPausing(false);
    setBusy(true);
    setFailure(undefined);
    const params = { path: { workspaceId: workspace, campaignId: campaign.id } };
    try {
      const answer =
        to === "pause"
          ? await data(browserApi().POST(PAUSE_PATH, { params }))
          : await data(browserApi().POST(RESUME_PATH, { params }));
      onChanged({ ...campaign, status: answer.status });
    } catch (error) {
      setFailure(codeOf(error));
      if (error instanceof ApiError) await onStale();
    }
    setBusy(false);
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium text-ink">{text.name(campaign.name)}</span>
        <StatusBadge status={campaign.status} />
        <span className="text-sm text-ink-muted">{text.version(campaign.versionNo)}</span>
        <span className="text-sm text-ink-muted">
          {campaign.launchedAt === null
            ? t("not_launched")
            : t("launched", { date: new Date(campaign.launchedAt) })}
        </span>
      </div>
      {campaign.status === "draft" ? (
        <p className="text-pretty text-sm text-ink-muted">{t("draft_note")}</p>
      ) : null}
      <div className="grid gap-2">
        <h3 className="font-medium text-ink">{t("steps")}</h3>
        <ol className="grid gap-2">
          {campaign.steps.map((step) => (
            <li
              key={step.stepKey}
              className="grid gap-1 rounded-xl border border-line bg-surface p-3 shadow-xs"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-ink">
                  {words.step(step.stepKey, step.action)}
                </span>
                <span className="text-sm text-ink-muted">{words.action(step.action)}</span>
              </div>
              <p className="text-sm text-ink-muted">{words.delay(step.delay)}</p>
              {step.condition === FALLBACK_CONDITION ? (
                <p className="text-sm text-ink-muted">{t("fallback")}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
      {failure === undefined ? null : <ErrorState module="campaigns" code={failure} />}
      {writable ? null : (
        <p className="text-pretty text-sm text-ink-muted">{editor("not_owner")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {writable && (active || campaign.status === "paused") ? (
          <Button loading={busy} onClick={() => (active ? setPausing(true) : move("resume"))}>
            {active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {active ? t("pause") : t("resume")}
          </Button>
        ) : null}
        <ButtonLink href={campaignScreen(workspace, campaign.id)}>{t("open")}</ButtonLink>
      </div>
      <Dialog
        open={pausing}
        onClose={() => setPausing(false)}
        title={t("pause_title")}
        actions={
          <Button variant="primary" onClick={() => move("pause")}>
            <Pause aria-hidden="true" />
            {t("pause")}
          </Button>
        }
      >
        <p>{t("pause_body")}</p>
      </Dialog>
    </div>
  );
}
