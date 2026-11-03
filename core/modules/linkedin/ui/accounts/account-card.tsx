"use client";
// The account card (README.md "Screen"): the label, with Refresh status at the inline end; the
// status as a badge in its colour, the time zone and the read cap, side by side; the working-hours
// editor; Disconnect, at the card's foot, with a confirmation. Refresh status, on a connected account
// or one the provider has a problem with, asks the worker for the status at the provider; the screen
// then asks for the account again (accounts.tsx). A pending card says the screen is waiting for the
// provider; a connected one shows the risk disclosure again on demand; one whose provider needs a
// new sign-in says to reconnect through the provider's page. One whose owner has not accepted the
// risk disclosure for sending shows its notice (disclosure-notice.tsx), and a toast once accepted;
// a disconnected one leaves that to Connect's boxes. Its pause (pause-switch.tsx) sits above the
// working hours. A failed action shows its code in words, with a retry of it.
import {
  Avatar,
  Badge,
  type BadgeTone,
  Button,
  ChipInput,
  Dialog,
  ErrorState,
  Select,
  Toast,
} from "@whytide/ui";
import {
  CalendarClock,
  ChevronDown,
  CircleCheck,
  CircleX,
  Globe,
  Hourglass,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  Unplug,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import type { AccountResponse } from "../../schemas/accounts.ts";
import { Disclosure } from "./connect-panel.tsx";
import { DisclosureNotice } from "./disclosure-notice.tsx";
import { PauseSwitch } from "./pause-switch.tsx";

type Props = {
  workspaceId: string;
  account: AccountResponse;
  /** The screen waits for the refreshed status. */
  refreshing: boolean;
  /** Refresh status was accepted: the screen waits for the new status. */
  onRefresh: () => void;
  /** The account changed here: the screen asks for it again. */
  onChange: () => Promise<unknown>;
};

/** The statuses a refresh may change: a pending account waits for its webhook, a disconnected one for Connect. */
const REFRESHABLE = new Set(["connected", "credentials_required", "error"]);
/** Each status's colour and icon, beside its words: good, waiting, needs the member, went wrong, off. */
const STATUS: Record<AccountResponse["status"], [tone: BadgeTone, Icon: LucideIcon]> = {
  pending: ["accent", Hourglass],
  connected: ["success", CircleCheck],
  credentials_required: ["warning", KeyRound],
  error: ["danger", CircleX],
  disconnected: ["neutral", Unplug],
};
const NOTE = "flex items-start gap-2.5 rounded-lg px-3 py-2.5";
/** A fact: its label and value in a row, side by side with the others where the card is wide. */
const FACT =
  "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-muted px-3 py-2.5 @lg:grid @lg:content-start @lg:justify-start";
/** Every half hour of the day, `HH:MM`; a time saved off the grid is kept as an option. */
const TIMES = Array.from({ length: 48 }, (_, half) => {
  const hours = String(Math.floor(half / 2)).padStart(2, "0");
  return `${hours}:${half % 2 === 0 ? "00" : "30"}`;
});
const timeOptions = (kept: string) =>
  (TIMES.includes(kept) ? TIMES : [...TIMES, kept].sort()).map((time) => ({
    value: time,
    label: time,
  }));

export function AccountCard({ workspaceId, account, refreshing, onRefresh, onChange }: Props) {
  const t = useTranslations("linkedin.account");
  const disclosure = useTranslations("linkedin.disclosure");
  const id = useId();
  const [start, setStart] = useState(account.workingHours.start);
  const [end, setEnd] = useState(account.workingHours.end);
  const [days, setDays] = useState(account.workingHours.days.map(String));
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saved, setSaved] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  /** The action that failed last, which the error's retry runs again. */
  const failed = useRef<() => Promise<void>>(undefined);

  const status = {
    pending: t("status.pending"),
    connected: t("status.connected"),
    credentials_required: t("status.credentials_required"),
    error: t("status.error"),
    disconnected: t("status.disconnected"),
  }[account.status];
  const dayOptions = [
    { value: "1", label: t("days.mon") },
    { value: "2", label: t("days.tue") },
    { value: "3", label: t("days.wed") },
    { value: "4", label: t("days.thu") },
    { value: "5", label: t("days.fri") },
    { value: "6", label: t("days.sat") },
    { value: "7", label: t("days.sun") },
  ];
  const path = { workspaceId, id: account.id };

  async function call(action: () => Promise<void>, request: () => Promise<unknown>) {
    failed.current = action;
    setFailure(undefined);
    setSaved(undefined);
    try {
      await request();
      return true;
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
      return false;
    }
  }

  async function save() {
    setSaving(true);
    const workingHours = { start, end, days: days.map(Number) };
    const done = await call(save, () =>
      data(
        browserApi().PATCH("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}", {
          params: { path },
          body: { workingHours },
        }),
      ),
    );
    setSaving(false);
    if (done) setSaved(t("saved"));
  }

  async function refresh() {
    setAsking(true);
    // One key per press: a retry of this request is answered once (core/apps/api "Request protection").
    const header = { "Idempotency-Key": crypto.randomUUID() };
    const done = await call(refresh, () =>
      data(
        browserApi().POST("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/refresh", {
          params: { path, header },
        }),
      ),
    );
    setAsking(false);
    if (done) onRefresh();
  }

  async function disconnect() {
    setConfirming(false);
    const done = await call(disconnect, () =>
      data(
        browserApi().DELETE("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}", {
          params: { path },
        }),
      ),
    );
    if (done) await onChange();
  }

  const [tone, StatusIcon] = STATUS[account.status];
  const busy = asking || refreshing;
  return (
    <section
      aria-labelledby={`${id}-label`}
      className="@container grid min-w-0 content-start gap-5 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6 [&_.wt-field]:min-w-0"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={account.label} size="lg" square />
          <h2
            id={`${id}-label`}
            className="min-w-0 text-base font-semibold wrap-break-word text-ink"
          >
            {account.label}
          </h2>
        </div>
        {REFRESHABLE.has(account.status) ? (
          <Button onClick={refresh} loading={busy}>
            {!busy && <RefreshCw aria-hidden="true" />}
            {t("refresh")}
          </Button>
        ) : null}
      </header>
      <dl className="grid gap-2 @lg:grid-cols-3 @lg:gap-3">
        <div className={FACT}>
          <dt className="text-xs font-medium text-ink-muted">{t("status_label")}</dt>
          <dd className="flex">
            <Badge tone={tone}>
              <StatusIcon aria-hidden="true" />
              {status}
            </Badge>
          </dd>
        </div>
        <div className={FACT}>
          <dt className="text-xs font-medium text-ink-muted">{t("time_zone")}</dt>
          <dd className="flex items-center gap-1.5 font-medium wrap-anywhere text-ink">
            <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
            {account.timeZone}
          </dd>
        </div>
        <div className={FACT}>
          <dt className="text-xs font-medium text-ink-muted">{t("cap_label")}</dt>
          <dd className="font-medium text-ink tabular-nums">
            {t("cap", { cap: account.dailyReadCap })}
          </dd>
        </div>
      </dl>
      {account.sendingDisclosureRequired && account.status !== "disconnected" ? (
        <DisclosureNotice
          workspaceId={workspaceId}
          account={account}
          onAccepted={async () => {
            await onChange();
            setSaved(disclosure("accepted"));
          }}
        />
      ) : null}
      {account.status === "pending" ? (
        <p className={`${NOTE} bg-accent-soft text-accent-ink`}>
          <span aria-hidden="true" className="wt-spinner mt-0.5" />
          {t("waiting")}
        </p>
      ) : null}
      {account.status === "credentials_required" ? (
        <p className={`${NOTE} border border-warm-dot/30 bg-warm-soft text-warm-ink`}>
          <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("reconnect")}
        </p>
      ) : null}
      {account.status === "connected" ? (
        <details className="group">
          <summary className="-mx-1.5 flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 font-medium text-ink transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden">
            <ChevronDown
              aria-hidden="true"
              className="size-4 -rotate-90 text-ink-muted transition-transform group-open:rotate-0 rtl:rotate-90 rtl:group-open:rotate-0"
            />
            {t("show_disclosure")}
          </summary>
          <div className="mt-2">
            <Disclosure />
          </div>
        </details>
      ) : null}
      <PauseSwitch workspaceId={workspaceId} account={account} onChange={onChange} />
      <form
        className="grid gap-4 border-t border-line pt-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="grid min-w-0 gap-4">
          <legend className="mb-4 flex items-center gap-2 font-semibold text-ink">
            <CalendarClock aria-hidden="true" className="size-4 text-ink-muted" />
            {t("working_hours")}
          </legend>
          <div className="grid gap-4 @md:grid-cols-2">
            <Select
              label={t("start")}
              value={start}
              onChange={(event) => setStart(event.target.value)}
              options={timeOptions(start)}
            />
            <Select
              label={t("end")}
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              options={timeOptions(end)}
            />
          </div>
          <ChipInput label={t("days_label")} value={days} onChange={setDays} options={dayOptions} />
        </fieldset>
        <div>
          <Button type="submit" variant="primary" loading={saving}>
            {t("save")}
          </Button>
        </div>
      </form>
      {account.status === "disconnected" ? null : (
        <div className="flex justify-end border-t border-line pt-5">
          <Button onClick={() => setConfirming(true)}>
            <Unplug aria-hidden="true" />
            {t("disconnect")}
          </Button>
        </div>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("disconnect")}
        actions={
          <Button variant="danger" onClick={disconnect}>
            {t("disconnect")}
          </Button>
        }
      >
        <p className="my-3">{t("disconnect_confirm")}</p>
      </Dialog>
      {failure ? (
        <ErrorState module="linkedin" code={failure} onRetry={() => void failed.current?.()} />
      ) : null}
      <Toast message={saved} />
    </section>
  );
}
