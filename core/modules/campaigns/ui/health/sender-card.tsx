// A LinkedIn sender's card on the Health page (senders.tsx), titled with the account's label and, in
// the view of a holder of linkedin.manage (an Owner's), naming its owner, or a former member; then,
// from linkedin's list, its status and its pause with who holds it, and, read in the browser from
// linkedin's health route, its health state since its change, the cool-down's end, the pending
// invitations and the last 5 events (state, trigger, time), newest first. Every time in the account's
// zone, named. Codes in linkedin's own words (`linkedin.account.status.*`, `linkedin.health.*`). The
// health has its own states: loading, and a refused read in words with Try again, the rest of the
// card and the other cards on screen meanwhile. A link leads to linkedin's page, where the account's
// owner acts: nothing here acts on it.
"use client";

import { Badge, Card, ErrorState, Link, LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { linkedinScreen } from "../constants.ts";
import {
  ACCOUNT_HEALTH_PATH,
  CARD_LOADING_LINES,
  EVENTS_SHOWN,
  STATE_TONES,
  TIME_FORMAT,
} from "./constants.ts";
import type { Account } from "./senders.tsx";

const readHealth = (workspace: string, id: string) =>
  browserApi().GET(ACCOUNT_HEALTH_PATH, { params: { path: { workspaceId: workspace, id } } });
type Health = NonNullable<Awaited<ReturnType<typeof readHealth>>["data"]>;
type Read = { health: Health } | { failed: string } | undefined;

const FACT = "grid gap-0.5 rounded-lg bg-muted px-3 py-2.5";
const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

/** linkedin's words for its codes, one t() call per code so that the message check reads each. */
function useLinkedinWords() {
  const status = useTranslations("linkedin.account.status");
  const health = useTranslations("linkedin.health");
  return {
    status: {
      pending: status("pending"),
      connected: status("connected"),
      credentials_required: status("credentials_required"),
      error: status("error"),
      disconnected: status("disconnected"),
    } satisfies Record<Account["status"], string>,
    state: {
      healthy: health("state.healthy"),
      at_risk: health("state.at_risk"),
      restricted: health("state.restricted"),
      checkpoint: health("state.checkpoint"),
      disconnected: health("state.disconnected"),
    } satisfies Record<Health["state"], string>,
    trigger: {
      acceptance_rate: health("trigger.acceptance_rate"),
      rate_limit_errors: health("trigger.rate_limit_errors"),
      checkpoint: health("trigger.checkpoint"),
      limit_reached: health("trigger.limit_reached"),
      session_invalid: health("trigger.session_invalid"),
      manual: health("trigger.manual"),
    } satisfies Record<Health["events"][number]["trigger"], string>,
    pending: (count: number | null) =>
      count === null ? health("pending_unknown") : health("pending", { count }),
  };
}

export function SenderCard({ workspace, account }: { workspace: string; account: Account }) {
  const t = useTranslations("campaigns.health");
  const words = useLinkedinWords();
  const format = useFormatter();
  const messages = useMessages();
  const id = useId();
  const [read, setRead] = useState<Read>();

  const load = useCallback(async () => {
    setRead(undefined);
    try {
      setRead({ health: await data(readHealth(workspace, account.id)) });
    } catch (error) {
      setRead({ failed: digestOf(error) });
    }
  }, [workspace, account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A time in words, in the account's zone and naming it; inside its <time>. */
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { ...TIME_FORMAT, timeZone: account.timeZone });
  const time = (iso: string) => <time dateTime={iso}>{when(iso)}</time>;
  const since = (iso: string) =>
    t.rich("sender.since", {
      at: when(iso),
      time: (chunks) => <time dateTime={iso}>{chunks}</time>,
    });
  const owner = !account.canManage
    ? undefined
    : account.ownerName === null
      ? t("sender.owner_removed")
      : t("sender.owner", { name: account.ownerName });
  const pausedBy = {
    tester: t("pause.tester"),
    operator: t("pause.operator"),
    member_removed: t("pause.member_removed"),
  };
  const pause = !account.paused
    ? t("pause.none")
    : account.pausedBy === null
      ? t("pause.on")
      : pausedBy[account.pausedBy];
  const fact = (label: string, value: ReactNode) => (
    <div className={FACT}>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="text-sm font-medium text-ink">{value}</dd>
    </div>
  );

  function health() {
    if (read === undefined) {
      return (
        <div aria-busy="true" className="grid gap-2">
          <LoadingState />
          <Skeleton lines={CARD_LOADING_LINES} />
        </div>
      );
    }
    if ("failed" in read) {
      const failure = errorOwner({ digest: read.failed }, messages);
      return (
        <div className="grid gap-2">
          <p className="text-sm font-medium text-ink">{t("sender.error")}</p>
          <ErrorState module={failure.module} code={failure.code} onRetry={() => void load()} />
        </div>
      );
    }
    const h = read.health;
    const events = h.events.slice(0, EVENTS_SHOWN);
    return (
      <>
        <dl className="grid gap-2 sm:grid-cols-2">
          {fact(
            t("fact.health"),
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone={STATE_TONES[h.state]}>{words.state[h.state]}</Badge>
              {h.since === null ? null : <span className="text-ink-muted">{since(h.since)}</span>}
            </span>,
          )}
          {h.pausedUntil === null ? null : fact(t("fact.cooldown"), time(h.pausedUntil))}
          {fact(t("fact.pending"), words.pending(h.pendingInvites))}
        </dl>
        <section aria-labelledby={`${id}-events`} className="grid gap-2">
          <h4 id={`${id}-events`} className="text-sm font-semibold text-ink">
            {t("sender.events")}
          </h4>
          {events.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("sender.no_events")}</p>
          ) : (
            <ol className="grid gap-2">
              {events.map((event) => (
                <li key={event.id} className="grid gap-0.5 rounded-lg border border-line px-3 py-2">
                  <span className="text-sm font-medium text-ink">{words.state[event.to]}</span>
                  <span className="text-sm text-ink-muted">{words.trigger[event.trigger]}</span>
                  <span className="text-xs text-ink-muted">{time(event.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </>
    );
  }

  return (
    <Card title={account.label} level={3} description={owner}>
      <dl className="grid gap-2 sm:grid-cols-2">
        {fact(t("fact.status"), words.status[account.status])}
        {fact(t("fact.pause"), pause)}
      </dl>
      {health()}
      <p className="text-sm">
        <Link href={linkedinScreen(workspace)}>{t("sender.open")}</Link>
      </p>
    </Card>
  );
}
