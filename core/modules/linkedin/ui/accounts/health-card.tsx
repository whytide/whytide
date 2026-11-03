"use client";
// The account's health (README.md "Screen", "Health"), a card under the account's, with its loading
// and error states: healthy, one line; at risk, a note; restricted or checkpoint, the cause, the
// times and what to do, "Check status" (the worker's refresh, then the health asked for again until
// the check's time moves) and Resume behind a Dialog, else a hint of why not; a lost session; the
// fleet breaker; the latest changes. The buttons are the owner's; a refused resume reloads the hint.
import {
  Badge,
  type BadgeTone,
  Button,
  Dialog,
  ErrorState,
  LoadingState,
  Skeleton,
  Toast,
} from "@whytide/ui";
import { HeartPulse, History, Megaphone, Play, RefreshCw, TriangleAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { RESUME_REFUSALS } from "../../domain/health/constants.ts";
import type { AccountResponse } from "../../schemas/accounts.ts";
import type { HealthResponse } from "../../schemas/health.ts";
import { HEALTH_LOADING_LINES, HEALTH_POLL_MS, HEALTH_POLLS } from "./constants.ts";

type Props = {
  workspaceId: string;
  account: AccountResponse;
  /** The account changed here: the screen asks for it again. */
  onChange: () => Promise<unknown>;
};
type Action = "refresh" | "resume";
/** What "Check status" waits for: a check's time other than `from`, `left` polls more at most. */
type Check = { readonly from: string | null; readonly left: number };

const TONES: Record<HealthResponse["state"], BadgeTone> = {
  healthy: "success",
  at_risk: "warning",
  restricted: "danger",
  checkpoint: "danger",
  disconnected: "neutral",
};
/** The resume's refusals: a fresh read of the health shows the same one as its hint. */
const REFUSALS = new Set<string>(RESUME_REFUSALS);
const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;
const NOTE = "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";
const FACT = "grid gap-0.5 rounded-lg bg-muted px-3 py-2.5";

export function HealthCard({ workspaceId, account, onChange }: Props) {
  const t = useTranslations("linkedin.health");
  const format = useFormatter();
  const title = useId();
  const [health, setHealth] = useState<HealthResponse>();
  const [failure, setFailure] = useState<string>();
  const [pressed, setPressed] = useState<{ action: Action; code: string }>();
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check>();
  const [slow, setSlow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string>();
  const path = { workspaceId, id: account.id };

  /** The health; `quiet` keeps the card as it is meanwhile, as a poll does. */
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) {
        setFailure(undefined);
        setHealth(undefined);
      }
      try {
        const params = { path: { workspaceId, id: account.id } };
        const route = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/health";
        setHealth(await data(browserApi().GET(route, { params })));
      } catch (error) {
        setFailure(error instanceof ApiError ? error.code : "internal_error");
        setCheck(undefined);
      }
    },
    [workspaceId, account.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (check === undefined || health === undefined) return;
    if (health.statusCheckedAt !== check.from) {
      setCheck(undefined);
      return;
    }
    if (check.left === 0) {
      setCheck(undefined);
      setSlow(true);
      return;
    }
    const timer = setTimeout(async () => {
      await load(true);
      setCheck((current) => current && { ...current, left: current.left - 1 });
    }, HEALTH_POLL_MS);
    return () => clearTimeout(timer);
  }, [check, health, load]);

  async function press(action: Action) {
    setConfirming(false);
    setBusy(true);
    setPressed(undefined);
    setSlow(false);
    setDone(undefined);
    // One key per press: a retry of this request is answered once (core/apps/api "Request protection").
    const params = { path, header: { "Idempotency-Key": crypto.randomUUID() } };
    try {
      if (action === "refresh") {
        const route = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/refresh";
        await data(browserApi().POST(route, { params }));
        setCheck({ from: health?.statusCheckedAt ?? null, left: HEALTH_POLLS });
      } else {
        const route = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/resume";
        setHealth(await data(browserApi().POST(route, { params, body: {} })));
        setDone(t("resumed"));
        await onChange();
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "internal_error";
      if (REFUSALS.has(code)) await load(true);
      else setPressed({ action, code });
    }
    setBusy(false);
  }

  const state = {
    healthy: t("state.healthy"),
    at_risk: t("state.at_risk"),
    restricted: t("state.restricted"),
    checkpoint: t("state.checkpoint"),
    disconnected: t("state.disconnected"),
  };
  const trigger = {
    acceptance_rate: t("trigger.acceptance_rate"),
    rate_limit_errors: t("trigger.rate_limit_errors"),
    checkpoint: t("trigger.checkpoint"),
    limit_reached: t("trigger.limit_reached"),
    session_invalid: t("trigger.session_invalid"),
    manual: t("trigger.manual"),
  };
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { ...WHEN, timeZone: account.timeZone });
  const owner = account.mine && account.canManage;
  const checking = check !== undefined;

  function body(h: HealthResponse) {
    const rate =
      h.acceptance.rate === null
        ? t("rate_unknown")
        : t("rate", { rate: h.acceptance.rate, sample: h.acceptance.sample });
    const pending =
      h.pendingInvites === null ? t("pending_unknown") : t("pending", { count: h.pendingInvites });
    const paused = h.state === "restricted" || h.state === "checkpoint";
    const blocked = {
      not_account_owner: t("blocked.not_account_owner"),
      account_not_paused: t("blocked.account_not_paused"),
      cooldown_active: t("blocked.cooldown_active"),
      linkedin_account_disconnected: t("blocked.linkedin_account_disconnected"),
      reconnect_required: t("blocked.reconnect_required"),
      status_check_required: t("blocked.status_check_required"),
    };
    const fact = (label: string, value: string) => (
      <div className={FACT}>
        <dt className="text-xs font-medium text-ink-muted">{label}</dt>
        <dd className="text-sm font-medium text-ink tabular-nums">{value}</dd>
      </div>
    );
    const checkButton = (
      <Button onClick={() => void press("refresh")} loading={checking} disabled={busy}>
        {!checking && <RefreshCw aria-hidden="true" />}
        {t("check")}
      </Button>
    );
    return (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Badge tone={TONES[h.state]}>{state[h.state]}</Badge>
          {h.state === "healthy" ? (
            <p className="flex flex-wrap gap-x-3 text-sm text-ink tabular-nums">
              <span>{rate}</span>
              <span>{pending}</span>
            </p>
          ) : null}
        </div>
        {h.state === "at_risk" ? (
          <div className={`${NOTE} border border-warm-dot/30 bg-warm-soft text-warm-ink`}>
            <TriangleAlert aria-hidden="true" className={ICON} />
            <div className="grid gap-0.5">
              <p>{t("at_risk")}</p>
              <p className="tabular-nums">{rate}</p>
            </div>
          </div>
        ) : null}
        {paused ? (
          <>
            <dl className="grid gap-2 sm:grid-cols-3">
              {fact(t("cause"), h.trigger === null ? state[h.state] : trigger[h.trigger])}
              {h.since === null ? null : fact(t("since"), when(h.since))}
              {h.pausedUntil === null ? null : fact(t("until"), when(h.pausedUntil))}
            </dl>
            <p className="text-sm text-ink">
              {h.state === "checkpoint" ? t("todo.checkpoint") : t("todo.restricted")}
            </p>
            {owner ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-2">
                  {checkButton}
                  <Button
                    variant="primary"
                    onClick={() => setConfirming(true)}
                    disabled={!h.canResume || busy || checking}
                  >
                    <Play aria-hidden="true" />
                    {t("resume")}
                  </Button>
                </div>
                {h.resumeBlockedBy === null ? null : (
                  <p className="text-sm text-ink-muted">{blocked[h.resumeBlockedBy]}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">{t("manage_only")}</p>
            )}
          </>
        ) : null}
        {h.state === "disconnected" ? (
          <div className="grid gap-2">
            <p className={`${NOTE} bg-muted text-ink`}>
              {h.status === "connected" ? t("disconnected_connected") : t("disconnected")}
            </p>
            {h.status === "connected" && owner ? <div>{checkButton}</div> : null}
          </div>
        ) : null}
        {slow ? <p className="text-sm text-ink-muted">{t("check_slow")}</p> : null}
        {h.invitesPaused ? (
          <p className={`${NOTE} border border-danger-line bg-danger-soft text-danger-ink`}>
            <Megaphone aria-hidden="true" className={ICON} />
            {t("breaker")}
          </p>
        ) : null}
        {pressed ? (
          <ErrorState
            module="linkedin"
            code={pressed.code}
            onRetry={() => void press(pressed.action)}
          />
        ) : null}
        <div className="grid gap-2 border-t border-line pt-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <History aria-hidden="true" className="size-4 text-ink-muted" />
            {t("events")}
          </h3>
          {h.events.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("no_events")}</p>
          ) : (
            <ol className="grid gap-1.5">
              {h.events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-sm"
                >
                  <span className="min-w-0 text-ink">
                    {event.from === event.to
                      ? state[event.to]
                      : t("event", { from: state[event.from], to: state[event.to] })}
                    {` · ${trigger[event.trigger]}`}
                  </span>
                  <time dateTime={event.at} className="text-ink-muted tabular-nums">
                    {when(event.at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>
      </>
    );
  }

  return (
    <section
      aria-labelledby={title}
      className="grid min-w-0 content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <h2 id={title} className="flex items-center gap-2 font-semibold text-ink">
        <HeartPulse aria-hidden="true" className="size-4 text-ink-muted" />
        {t("title")}
      </h2>
      {failure !== undefined ? (
        <ErrorState module="linkedin" code={failure} onRetry={() => void load()} />
      ) : health === undefined ? (
        <div aria-busy="true" className="grid gap-3">
          <LoadingState />
          <Skeleton lines={HEALTH_LOADING_LINES} />
        </div>
      ) : (
        body(health)
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("resume_title")}
        actions={
          <Button variant="primary" onClick={() => void press("resume")}>
            {t("resume")}
          </Button>
        }
      >
        <p className="my-3">{t("resume_body")}</p>
      </Dialog>
      <Toast message={done} />
    </section>
  );
}
