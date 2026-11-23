"use client";
// The campaign's approval mode (README.md "The approval mode"; gamma-p4-070), a card of the
// campaign's page: the two modes, "Review everything until <date>" while the campaign's first 7 days
// last, when "Review first touches" cannot be chosen, and the AI disclosure line each channel's
// follow-ups will carry in "Review first touches", messaging's panels from the page's disclosure
// slot, shown before the switch. Save puts the mode (PUT …/approval-mode) and shows the api's answer,
// or its refusal's code in words. A member without campaigns.approval_mode sees the mode without the
// control.
import { Button, Card, ErrorState, SaveBar } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import {
  APPROVAL_MODES,
  type ApprovalMode,
  REVIEW_FIRST_TOUCHES,
} from "../../domain/approval-mode/constants.ts";
import type { ApprovalModeResponse } from "../../schemas/campaigns.ts";
import { APPROVAL_MODE_PATH } from "../constants.ts";

type Props = {
  readonly workspace: string;
  readonly campaignId: string;
  readonly initial: ApprovalModeResponse;
  /** Whether the campaign's first 7 days last, read with the page. */
  readonly locked: boolean;
  /** messaging's AI disclosure lines, a LinkedIn message's and an email's. */
  readonly lines: ReactNode;
  /** Whether the member holds campaigns.approval_mode: an Owner or an Admin. */
  readonly writable: boolean;
};

export function ApprovalModePicker(props: Props) {
  const { workspace, campaignId, initial, locked, lines, writable } = props;
  const t = useTranslations("campaigns.approval_mode");
  const ids = { name: useId(), preview: useId() };
  const [mode, setMode] = useState(initial);
  const [chosen, setChosen] = useState<ApprovalMode>(initial.mode);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [saved, setSaved] = useState(false);
  const label: Record<ApprovalMode, string> = {
    review_everything: locked
      ? t("locked_until", { date: new Date(mode.lockedUntil) })
      : t("review_everything"),
    review_first_touches: t("review_first_touches"),
  };
  const hint: Record<ApprovalMode, string> = {
    review_everything: t("review_everything_hint"),
    review_first_touches: t("review_first_touches_hint"),
  };
  const preview = (
    <div id={ids.preview} className="grid gap-1 rounded-lg bg-muted p-3">
      <p className="text-sm font-medium text-ink">{t("disclosure_preview")}</p>
      {lines}
    </div>
  );

  async function save() {
    setBusy(true);
    setFailure(undefined);
    setSaved(false);
    try {
      const params = { path: { workspaceId: workspace, campaignId } };
      const body = { mode: chosen };
      const answer = await data(browserApi().PUT(APPROVAL_MODE_PATH, { params, body }));
      setMode(answer);
      setChosen(answer.mode);
      setSaved(true);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : new ApiError(500, undefined).code);
    }
    setBusy(false);
  }

  if (!writable) {
    const current = mode.effectiveMode;
    return (
      <Card title={t("title")} description={hint[current]}>
        <p className="font-medium text-ink">{label[current]}</p>
        {current === REVIEW_FIRST_TOUCHES ? preview : null}
      </Card>
    );
  }
  return (
    <Card title={t("title")}>
      <fieldset className="grid gap-3">
        <legend className="sr-only">{t("title")}</legend>
        {APPROVAL_MODES.map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-3 rounded-lg p-3 ring-1 ring-line ring-inset has-checked:ring-2 has-checked:ring-accent has-disabled:cursor-not-allowed has-disabled:opacity-60"
          >
            <input
              type="radio"
              name={ids.name}
              value={value}
              checked={chosen === value}
              disabled={busy || (locked && value === REVIEW_FIRST_TOUCHES)}
              aria-describedby={value === REVIEW_FIRST_TOUCHES ? ids.preview : undefined}
              onChange={() => setChosen(value)}
              className="mt-1 accent-accent"
            />
            <span className="grid gap-0.5">
              <span className="font-medium text-ink">{label[value]}</span>
              <span className="text-pretty text-sm text-ink-muted">{hint[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {preview}
      {failure === undefined ? null : <ErrorState module="campaigns" code={failure} />}
      <SaveBar
        dirty={chosen !== mode.mode}
        note={<span role="status">{saved ? t("saved") : null}</span>}
      >
        <Button variant="primary" loading={busy} disabled={chosen === mode.mode} onClick={save}>
          {t("save")}
        </Button>
      </SaveBar>
    </Card>
  );
}
