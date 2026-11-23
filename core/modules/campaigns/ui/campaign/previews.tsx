"use client";
// The previews (README.md "Screens"): a sample lead, one of the first leads by fit in the kit's
// Select, then each LinkedIn step of the current version: the connection request, which goes
// without a note, and each message with Preview, which asks messaging for a draft of the lead as the
// step's kind (POST …/leads/{personId}/drafts, 202 `drafting`), reads it again until its writer
// ends, as messaging's draft panel does, then shows its text, or why it was flagged or failed. A
// preview is the lead's draft in messaging, which the lead's page lists; it writes nothing on the
// campaign. Another lead clears the previews shown.
import { Button, Card, ErrorState, Select } from "@whytide/ui";
import { Eye } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { StepResponse } from "../../schemas/campaigns.ts";
import {
  DRAFT_PATH,
  LEAD_DRAFTS_PATH,
  MS_PER_MINUTE,
  PREVIEW_CHANNEL,
  PREVIEW_KINDS,
  PREVIEW_POLL_AGE_SHARE,
  PREVIEW_POLL_FOR_MS,
  PREVIEW_POLL_MAX_MS,
  PREVIEW_POLL_MS,
} from "../constants.ts";
import { type GateIssue, useCampaignWords } from "./words.ts";

/** A lead of contacts' list, the fields the Select names it by. */
export type SampleLead = {
  readonly personId: string;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
};
/** A draft as messaging's routes answer it, the fields a preview shows. */
type Draft = {
  readonly id: string;
  readonly status: string;
  readonly text: string | null;
  readonly editedText: string | null;
  readonly flagReasons: readonly object[];
  readonly createdAt: string;
};
type Props = { workspace: string; leads: readonly SampleLead[]; steps: readonly StepResponse[] };

const codeOf = (error: unknown) =>
  error instanceof ApiError ? error.code : new ApiError(500, undefined).code;
/** The wait before a draft asked for at `createdAt` is read again; none once it is too old. */
function pollDelay(createdAt: string, now = Date.now()): number | undefined {
  const age = now - Date.parse(createdAt);
  if (age > PREVIEW_POLL_FOR_MS) return undefined;
  return Math.min(PREVIEW_POLL_MAX_MS, Math.max(PREVIEW_POLL_MS, age / PREVIEW_POLL_AGE_SHARE));
}
const isIssue = (reason: object): reason is GateIssue =>
  "gate" in reason && typeof reason.gate === "string";
const failureCode = (reasons: readonly object[]) => {
  const found = reasons.find((reason) => "code" in reason && typeof reason.code === "string");
  return found !== undefined && "code" in found && typeof found.code === "string" ? found.code : "";
};

export function Previews({ workspace, leads, steps }: Props) {
  const t = useTranslations("campaigns.preview");
  const words = useCampaignWords();
  const [personId, setPersonId] = useState(leads[0]?.personId);
  const messages = steps.filter(({ action }) => action === "message");
  const options = leads.map((lead) => ({
    value: lead.personId,
    label: `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim() || t("unnamed"),
  }));
  return (
    <Card title={t("title")} description={t("description")}>
      {personId === undefined ? (
        <p className="text-pretty text-ink-muted">{t("no_leads")}</p>
      ) : (
        <>
          <div className="max-w-md">
            <Select
              label={t("lead")}
              value={personId}
              options={options}
              onChange={(event) => setPersonId(event.target.value)}
            />
          </div>
          <ul className="grid gap-3">
            <li className="grid gap-1 rounded-xl border border-line bg-surface p-3 shadow-xs">
              <span className="font-medium text-ink">{words.step("connect", "invite")}</span>
              <p className="text-sm text-ink-muted">{t("connect_note")}</p>
            </li>
            {messages.map((step) => (
              <Preview
                key={`${personId}:${step.stepKey}`}
                workspace={workspace}
                personId={personId}
                step={step}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** One message's preview for the lead: Preview, then the draft until its writer ends. */
function Preview(props: { workspace: string; personId: string; step: StepResponse }) {
  const { workspace, personId, step } = props;
  const t = useTranslations("campaigns.preview");
  const words = useCampaignWords();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [stopped, setStopped] = useState(false);
  const name = words.step(step.stepKey, step.action);
  const stepKind = Object.hasOwn(PREVIEW_KINDS, step.stepKey)
    ? PREVIEW_KINDS[step.stepKey as keyof typeof PREVIEW_KINDS]
    : undefined;

  async function ask() {
    setBusy(true);
    setFailure(undefined);
    setStopped(false);
    try {
      const header = { "Idempotency-Key": crypto.randomUUID() };
      const params = { path: { workspaceId: workspace, personId }, header };
      const body = { channel: PREVIEW_CHANNEL, stepKind } as const;
      setDraft(await data(browserApi().POST(LEAD_DRAFTS_PATH, { params, body })));
    } catch (error) {
      setFailure(codeOf(error));
    }
    setBusy(false);
  }

  // The draft being written, read again until its writer ends; too old, no more.
  useEffect(() => {
    if (draft?.status !== "drafting" || stopped || failure !== undefined) return;
    const delay = pollDelay(draft.createdAt);
    if (delay === undefined) {
      setStopped(true);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const params = { path: { workspaceId: workspace, id: draft.id } };
        setDraft(await data(browserApi().GET(DRAFT_PATH, { params })));
      } catch (error) {
        setFailure(codeOf(error));
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [draft, stopped, failure, workspace]);

  const writing = busy || draft?.status === "drafting";
  const shown = draft?.editedText ?? draft?.text;
  return (
    <li className="grid gap-2 rounded-xl border border-line bg-surface p-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="font-medium text-ink">{name}</span>
        <Button
          size="sm"
          aria-label={t("preview", { step: name })}
          loading={writing && !stopped}
          onClick={ask}
        >
          <Eye aria-hidden="true" />
          {t("ask")}
        </Button>
      </div>
      <div aria-live="polite" className="grid gap-2">
        {stopped ? (
          <p className="text-pretty text-sm text-ink-muted">
            {t("stuck", { minutes: PREVIEW_POLL_FOR_MS / MS_PER_MINUTE })}
          </p>
        ) : writing ? (
          <p role="status" className="text-sm text-ink-muted">
            {t("writing")}
          </p>
        ) : null}
        {draft === undefined || writing ? null : draft.status === "failed" ? (
          <p className="text-pretty text-sm text-danger-ink">
            {t("failed", { reason: words.failure(failureCode(draft.flagReasons)) })}
          </p>
        ) : (
          <>
            {shown ? (
              <p data-part="preview" className="whitespace-pre-wrap text-pretty text-ink">
                {shown}
              </p>
            ) : null}
            {draft.status === "flagged" ? (
              <div className="grid gap-1 text-sm">
                <p className="font-medium text-danger-ink">{t("flagged")}</p>
                <ul className="grid gap-1 text-ink-muted">
                  {draft.flagReasons.filter(isIssue).map((issue, index) => (
                    // An issue's place is its key: the list is the draft's, read once.
                    <li key={index}>{words.gate(issue)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
      {failure === undefined ? null : <ErrorState module="messaging" code={failure} />}
    </li>
  );
}
