"use client";
// The account's pause (README.md "Screen"), on its card and on a teammate's: a Switch, on while the
// account is paused, that asks for confirmation both ways. Paused, the account takes no LinkedIn
// action from the next one, reads included, until it is resumed. The route's flags say who may press
// it (canPause, canUnpause; gamma-p6-070). The operator's pause shows locked, saying so; a removed
// member's reads as such, locked for everyone but its owner; for a member who may not change it
// otherwise the Switch is disabled with a hint. A failed press shows its code in words, with a retry.
import { Button, Dialog, ErrorState, Switch } from "@whytide/ui";
import { CirclePause, Lock } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { AccountResponse } from "../../schemas/accounts.ts";

type Props = {
  workspaceId: string;
  account: AccountResponse;
  /** The account changed here: the screen asks for it again. */
  onChange: () => Promise<unknown>;
};

const NOTE = "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";

export function PauseSwitch({ workspaceId, account, onChange }: Props) {
  const t = useTranslations("linkedin.controls");
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { paused, pausedBy, canPause, canUnpause } = account;
  const locked = pausedBy === "operator";
  const removed = pausedBy === "member_removed";
  // The route's rules: its owner or an Owner pauses and lifts a tester's pause; only its owner a
  // removed member's; only the operator the operator's.
  const hint = locked
    ? t("locked.account")
    : removed && !canUnpause
      ? t("locked.member_removed")
      : paused
        ? canUnpause
          ? undefined
          : t("hint.owner_only")
        : canPause
          ? undefined
          : t("hint.manage_only");

  async function press() {
    setConfirming(false);
    setBusy(true);
    setFailure(undefined);
    // One key per press: a retry of this request is answered once (core/apps/api "Request protection").
    const header = { "Idempotency-Key": crypto.randomUUID() };
    const params = { path: { workspaceId, id: account.id }, header };
    try {
      await data(
        paused
          ? browserApi().POST("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/unpause", {
              params,
            })
          : browserApi().POST("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/pause", {
              params,
            }),
      );
      await onChange();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3 border-t border-line pt-5">
      <div className="flex items-start justify-between gap-4">
        <div className="grid min-w-0 gap-1">
          <label
            htmlFor={`${id}-switch`}
            className="flex items-center gap-2 font-semibold text-ink"
          >
            <CirclePause aria-hidden="true" className="size-4 text-ink-muted" />
            {t("pause.label")}
          </label>
          <p id={`${id}-about`} className="text-sm text-ink-muted">
            {t("pause.description")}
          </p>
        </div>
        <Switch
          id={`${id}-switch`}
          checked={paused}
          disabled={busy || hint !== undefined}
          aria-describedby={hint === undefined ? `${id}-about` : `${id}-about ${id}-hint`}
          onChange={() => setConfirming(true)}
        />
      </div>
      {paused && !locked ? (
        <p className={`${NOTE} border border-warm-dot/30 bg-warm-soft text-warm-ink`}>
          <CirclePause aria-hidden="true" className={ICON} />
          {removed ? t("pause.member_removed") : t("pause.on")}
        </p>
      ) : null}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className={`${NOTE} bg-muted text-ink`}>
          <Lock aria-hidden="true" className={`${ICON} text-ink-muted`} />
          {hint}
        </p>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={paused ? t("resume.confirm_title") : t("pause.confirm_title")}
        actions={
          <Button variant={paused ? "primary" : "danger"} onClick={press}>
            {paused ? t("resume.confirm") : t("pause.confirm")}
          </Button>
        }
      >
        <p className="my-3">{paused ? t("resume.confirm_body") : t("pause.confirm_body")}</p>
      </Dialog>
      {failure ? <ErrorState module="linkedin" code={failure} onRetry={press} /> : null}
    </div>
  );
}
