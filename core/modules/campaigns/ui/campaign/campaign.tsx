"use client";
// The campaign's page in the browser (README.md "Screens"): the way back to the list; the header with
// the campaign's name (the seeded one's in words), its status, its current version and its launch
// date, and, for an active or paused campaign, Pause, which asks first in the kit's Dialog, or Resume
// (gamma-p3-061's routes); its name, saved with the kit's SaveBar through PATCH
// …/campaigns/{campaignId}; the sequence editor (editor.tsx); a draft's launch panel (launch.tsx);
// and the previews (previews.tsx). Each change shows the api's answer; a refused pause or resume
// shows its code in words and reads the campaign again, which may have moved meanwhile. Another
// member's campaign, the seeded one included, for a member without campaigns.manage: a hint, its
// name, sequence and launch read-only, no Pause or Resume (README.md "Decided here"). The approval
// mode's card (../approval-mode/), which the page renders, comes after the name (gamma-p4-070).
import {
  Button,
  ButtonLink,
  Card,
  Dialog,
  ErrorState,
  PageHeader,
  SaveBar,
  TextField,
} from "@whytide/ui";
import { ArrowLeft, Pause, Play } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";
import { CAMPAIGN_NAME_MAX } from "../../domain/campaigns/constants.ts";
import type { CampaignResponse, LaunchChecksResponse } from "../../schemas/campaigns.ts";
import { StatusBadge, useCampaignText } from "../common.tsx";
import { CAMPAIGN_PATH, campaignsScreen, PAUSE_PATH, RESUME_PATH } from "../constants.ts";
import { Editor } from "./editor.tsx";
import { Launch } from "./launch.tsx";
import { Previews, type SampleLead } from "./previews.tsx";
import type { PriceEntry } from "./price.tsx";

type Props = {
  workspace: string;
  initial: CampaignResponse;
  /** The price of a LinkedIn send, from credits' price list; none when the list has no entry. */
  price?: PriceEntry;
  leads: readonly SampleLead[];
  /** A draft's launch checks, read with the page. */
  checks?: LaunchChecksResponse["checks"];
  /** Whether the member may change it: its owner, or a holder of campaigns.manage. */
  writable: boolean;
  /** The approval mode's card. */
  mode: ReactNode;
};

const codeOf = (error: unknown) =>
  error instanceof ApiError ? error.code : new ApiError(500, undefined).code;

export function Campaign({ workspace, initial, price, leads, checks, writable, mode }: Props) {
  const t = useTranslations("campaigns.editor");
  const kit = useTranslations("ui.action");
  const text = useCampaignText();
  const [campaign, setCampaign] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [busy, setBusy] = useState<"name" | "status">();
  const [failure, setFailure] = useState<string>();
  const [renamed, setRenamed] = useState(false);
  const [pausing, setPausing] = useState(false);
  const params = { path: { workspaceId: workspace, campaignId: campaign.id } };
  const changed = name.trim() !== campaign.name;

  /** The campaign as the api has it now. */
  async function reread() {
    try {
      setCampaign(await data(browserApi().GET(CAMPAIGN_PATH, { params })));
    } catch (error) {
      setFailure(codeOf(error));
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || name.trim() === "") return;
    setBusy("name");
    setFailure(undefined);
    setRenamed(false);
    try {
      const body = { name: name.trim() };
      const answer = await data(browserApi().PATCH(CAMPAIGN_PATH, { params, body }));
      setCampaign((current) => ({ ...current, name: answer.name }));
      setName(answer.name);
      setRenamed(true);
    } catch (error) {
      setFailure(codeOf(error));
    }
    setBusy(undefined);
  }

  async function move(to: "pause" | "resume") {
    setPausing(false);
    setBusy("status");
    setFailure(undefined);
    try {
      const answer =
        to === "pause"
          ? await data(browserApi().POST(PAUSE_PATH, { params }))
          : await data(browserApi().POST(RESUME_PATH, { params }));
      setCampaign((current) => ({ ...current, status: answer.status }));
    } catch (error) {
      setFailure(codeOf(error));
      if (error instanceof ApiError) await reread();
    }
    setBusy(undefined);
  }

  const title = text.name(campaign.name);
  const active = campaign.status === "active";
  const actions =
    writable && (active || campaign.status === "paused") ? (
      <Button
        loading={busy === "status"}
        disabled={busy === "name"}
        onClick={() => (active ? setPausing(true) : move("resume"))}
      >
        {active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        {active ? t("pause") : t("resume")}
      </Button>
    ) : undefined;

  return (
    <>
      <title>{title}</title>
      <div className="-ms-2.5 -mt-2 mb-5">
        <ButtonLink href={campaignsScreen(workspace)} variant="ghost" size="sm">
          <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
          {t("back")}
        </ButtonLink>
      </div>
      <PageHeader
        title={title}
        meta={
          <>
            <StatusBadge status={campaign.status} />
            <span className="text-sm text-ink-muted">{text.version(campaign.versionNo)}</span>
            {campaign.launchedAt === null ? null : (
              <span className="text-sm text-ink-muted">
                {t("launched", { date: new Date(campaign.launchedAt) })}
              </span>
            )}
          </>
        }
        actions={actions}
      />
      <div className="grid gap-6">
        {writable ? null : <p className="text-pretty text-ink-muted">{t("not_owner")}</p>}
        {failure === undefined ? null : <ErrorState module="campaigns" code={failure} />}
        <Card title={t("details")}>
          <form className="grid gap-4" onSubmit={rename}>
            <div className="max-w-md">
              <TextField
                label={t("name")}
                value={name}
                maxLength={CAMPAIGN_NAME_MAX}
                placeholder={text.name("")}
                disabled={!writable}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {writable ? (
              <SaveBar
                dirty={changed}
                note={<span role="status">{renamed ? t("name_saved") : null}</span>}
              >
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === "name"}
                  disabled={!changed || name.trim() === "" || busy === "status"}
                >
                  {kit("save")}
                </Button>
              </SaveBar>
            ) : null}
          </form>
        </Card>
        {mode}
        <Editor
          workspace={workspace}
          campaign={campaign}
          price={price}
          readOnly={!writable}
          onSaved={({ versionNo, steps }) =>
            setCampaign((current) => ({ ...current, versionNo, steps, stepCount: steps.length }))
          }
        />
        {campaign.status === "draft" && checks !== undefined ? (
          <Launch
            workspace={workspace}
            campaignId={campaign.id}
            first={checks}
            price={price}
            readOnly={!writable}
            onLaunched={({ status, launchedAt }) =>
              setCampaign((current) => ({ ...current, status, launchedAt }))
            }
            onStale={reread}
          />
        ) : null}
        <Previews workspace={workspace} leads={leads} steps={campaign.steps} />
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
    </>
  );
}
