"use client";
// The workspace's sources (README.md "Screen"), a card each, two side by side on a wide screen, the
// one whose runs show marked, by its ring and aria-current: the label, the enabled switch, the
// post, the sender account with a warning and a link to the LinkedIn screen when it is not
// connected (the source is blocked), the last run, the next fire times (the next one in bold);
// while a run is open, its line in words (run-state.tsx) with Stop ("Stopping…" once asked), apart
// from the card's actions: Run now (disabled while a run of it is open, described by that line),
// its runs and Delete, which asks first. A change reads the screen again.
import { Button, ButtonLink, Dialog, EmptyState, ErrorState, Link, Switch } from "@whytide/ui";
import {
  Clock,
  ExternalLink,
  ListChecks,
  Play,
  Radar,
  Square,
  Trash2,
  TriangleAlert,
  UserRound,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CONNECTED, linkedinScreen, runStateId } from "./constants.ts";
import { RunState } from "./run-state.tsx";
import { When } from "./when.tsx";

export type Account = {
  id: string;
  label: string;
  status: string;
  timeZone: string;
  workingHours: { start: string; end: string; days: number[] };
  mine: boolean;
};
export type Source = {
  id: string;
  label: string;
  config: { [key: string]: unknown };
  senderAccountId: string;
  enabled: boolean;
  lastRunAt: string | null;
  fireTimes: string[];
  nextRunAt: string | null;
  runOpen: boolean;
  openRun: { id: string; status: "running" | "waiting"; stopRequestedAt: string | null } | null;
};
/** linkedin's usage of a sender account today, as `GET …/accounts/{id}/usage` answers it. */
export type Usage = {
  cap: number;
  reserved: number;
  committed: number;
  windowOpen: boolean;
  nextWindowAt: string;
};
type Props = {
  workspaceId: string;
  sources: Source[];
  accounts: Account[];
  /** The usage of each connected sender account with a waiting run, by its id. */
  usage: ReadonlyMap<string, Usage>;
  /** Reads the screen again, after a change. */
  onChange: () => Promise<void>;
  /** A run asked for, by Run now. */
  onRan: (source: Source) => void;
  /** The source whose runs the panel shows: its card is marked. */
  runsOf: string | undefined;
};

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
/** A fact of a card: its name over its value. */
const TERM = "text-xs font-medium text-ink-muted";

export function SourceList(props: Props) {
  const { workspaceId, sources, accounts, usage, onChange, onRan, runsOf } = props;
  const t = useTranslations("signals");
  const [failure, setFailure] = useState<string>();
  const [deleting, setDeleting] = useState<Source>();

  async function remove(source: Source) {
    setDeleting(undefined);
    setFailure(undefined);
    try {
      const path = { workspaceId, id: source.id };
      await data(
        browserApi().DELETE("/v1/workspaces/{workspaceId}/signals/sources/{id}", {
          params: { path },
        }),
      );
      await onChange();
    } catch (error) {
      setFailure(codeOf(error));
    }
  }

  const senderOf = (source: Source) => accounts.find(({ id }) => id === source.senderAccountId);
  const next = (source: Source) => {
    if (!source.enabled) return t("sources.paused");
    if (source.nextRunAt === null) return t("sources.no_more_runs");
    return (
      <ol className="grid gap-1">
        {source.fireTimes.map((at, index) => (
          <li key={at} className={index === 0 ? "font-semibold text-ink" : "text-ink-muted"}>
            <When at={at} />
          </li>
        ))}
      </ol>
    );
  };
  const postUrl = (source: Source) =>
    typeof source.config.postUrl === "string" ? source.config.postUrl : undefined;

  const card = (source: Source) => {
    const sender = senderOf(source);
    const open = source.openRun;
    const heading = `signals-source-${source.id}`;
    return (
      <article
        key={source.id}
        aria-labelledby={heading}
        aria-current={source.id === runsOf ? "true" : undefined}
        className={`@container flex flex-col gap-4 rounded-xl border bg-surface p-5 shadow-xs ${source.id === runsOf ? "border-accent/50 ring-4 ring-accent-soft" : "border-line"}`}
      >
        <header className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
            <Radar aria-hidden="true" className="size-4.5" />
          </span>
          <div className="grid min-w-0 flex-1">
            <span className="text-xs text-ink-muted">{t("kinds.post_engagers.label")}</span>
            <h3 id={heading} className="text-pretty font-semibold text-ink wrap-break-word">
              {source.label}
            </h3>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-ink-muted">
            {t("sources.enabled")}
            <EnabledSwitch
              key={`${source.id}:${source.enabled}`}
              workspaceId={workspaceId}
              source={source}
              onChange={onChange}
              onFailure={setFailure}
            />
          </label>
        </header>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Link href={postUrl(source)} target="_blank" rel="noreferrer">
            {t("sources.view_post")}
            <ExternalLink
              aria-hidden="true"
              className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
            />
          </Link>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-muted">
            <UserRound aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{sender?.label ?? t("sources.account_unknown")}</span>
          </span>
        </div>
        {sender?.status === CONNECTED ? null : (
          <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-danger-ink">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="font-medium">{t("sources.account_disconnected")}</strong>{" "}
              <Link href={linkedinScreen(workspaceId)}>{t("sources.blocked")}</Link>
            </span>
          </p>
        )}
        <dl className="grid gap-4 @md:grid-cols-2">
          <div className="grid content-start gap-1">
            <dt className={TERM}>{t("sources.last_run")}</dt>
            <dd className="text-ink">
              {source.lastRunAt ? <When at={source.lastRunAt} /> : t("sources.never")}
            </dd>
          </div>
          <div className="grid content-start gap-1">
            <dt className={TERM}>{t("sources.next_run")}</dt>
            <dd className="text-ink-muted">{next(source)}</dd>
          </div>
        </dl>
        {open ? (
          <div
            className={`flex flex-wrap items-center gap-3 rounded-lg px-3.5 py-3 ${open.status === "running" ? "bg-accent-soft text-accent-ink" : "bg-warm-soft text-warm-ink"}`}
          >
            {open.status === "running" ? (
              <span className="wt-spinner" aria-hidden="true" />
            ) : (
              <Clock aria-hidden="true" className="size-4 shrink-0" />
            )}
            <RunState
              workspaceId={workspaceId}
              source={source}
              sender={sender}
              usage={usage.get(source.senderAccountId)}
            />
            <StopRun
              key={open.id}
              workspaceId={workspaceId}
              source={source}
              onStopped={onChange}
              onFailure={setFailure}
            />
          </div>
        ) : null}
        <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <RunNow
            workspaceId={workspaceId}
            source={source}
            onRan={onRan}
            onFailure={(code) => {
              setFailure(code);
              if (code !== undefined) void onChange();
            }}
          />
          <ButtonLink
            href={`?runs=${source.id}`}
            variant="ghost"
            aria-label={t("runs.title", { label: source.label })}
          >
            <ListChecks aria-hidden="true" />
            {t("runs.show")}
          </ButtonLink>
          <span className="ms-auto">
            <Button variant="ghost" onClick={() => setDeleting(source)}>
              <Trash2 aria-hidden="true" />
              {t("sources.delete")}
            </Button>
          </span>
        </footer>
      </article>
    );
  };

  return (
    <section aria-labelledby="signals-sources-list" className="grid gap-4">
      <h2 id="signals-sources-list" className="font-semibold text-ink">
        {t("sources.list_title")}
      </h2>
      {failure ? <ErrorState module="signals" code={failure} /> : null}
      {sources.length === 0 ? (
        <EmptyState message={t("sources.empty")} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">{sources.map(card)}</div>
      )}
      <Dialog
        open={deleting !== undefined}
        onClose={() => setDeleting(undefined)}
        title={t("sources.delete_title", { label: deleting?.label ?? "" })}
        actions={
          <Button variant="danger" onClick={() => deleting && remove(deleting)}>
            {t("sources.delete")}
          </Button>
        }
      >
        <p className="my-3">{t("sources.delete_confirm")}</p>
      </Dialog>
    </section>
  );
}

/**
 * Run now: one Idempotency-Key per press, busy until the api answers. Disabled while a run of the
 * source is open, described by the line under it that says why; a refusal (signal_run_open, when one
 * opened since the list was read) shows in words, and the list is read again.
 */
function RunNow(props: {
  workspaceId: string;
  source: Source;
  onRan: (source: Source) => void;
  onFailure: (code: string | undefined) => void;
}) {
  const { workspaceId, source, onRan, onFailure } = props;
  const t = useTranslations("signals");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    onFailure(undefined);
    try {
      const header = { "Idempotency-Key": crypto.randomUUID() };
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/signals/sources/{id}/run", {
          params: { path: { workspaceId, id: source.id }, header },
        }),
      );
      onRan(source);
    } catch (error) {
      onFailure(codeOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      onClick={run}
      loading={busy}
      disabled={source.runOpen}
      aria-describedby={source.openRun ? runStateId(source.id) : undefined}
    >
      {busy ? null : <Play aria-hidden="true" />}
      {t("sources.run_now")}
    </Button>
  );
}

/**
 * Stop, in the open run's line, apart from Run now: one Idempotency-Key per press, then the list read
 * again. "Stopping…" and disabled from the press on, and whenever the open run has its
 * stop asked (a reload); no confirmation, as Run now runs it again. A refusal (signal_run_not_open,
 * when the run ended since the list was read) shows in words, and the list is read again.
 */
function StopRun(props: {
  workspaceId: string;
  source: Source;
  onStopped: () => Promise<void>;
  onFailure: (code: string | undefined) => void;
}) {
  const { workspaceId, source, onStopped, onFailure } = props;
  const t = useTranslations("signals");
  const [asked, setAsked] = useState(false);
  const run = source.openRun;
  if (!run) return null;
  const stopping = asked || run.stopRequestedAt !== null;

  async function stop(runId: string) {
    setAsked(true);
    onFailure(undefined);
    try {
      const header = { "Idempotency-Key": crypto.randomUUID() };
      const path = { workspaceId, id: source.id, runId };
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/signals/sources/{id}/runs/{runId}/stop", {
          params: { path, header },
        }),
      );
    } catch (error) {
      setAsked(false);
      onFailure(codeOf(error));
    }
    await onStopped();
  }

  return (
    <Button
      size="sm"
      onClick={() => stop(run.id)}
      disabled={stopping}
      aria-describedby={runStateId(source.id)}
    >
      <Square aria-hidden="true" className="fill-current text-danger-ink" />
      {stopping ? t("sources.stopping") : t("sources.stop")}
    </Button>
  );
}

/** The enabled switch: it moves at once and back when the api refuses (the limit, say). */
function EnabledSwitch(props: {
  workspaceId: string;
  source: Source;
  onChange: () => Promise<void>;
  onFailure: (code: string | undefined) => void;
}) {
  const { workspaceId, source, onChange, onFailure } = props;
  const t = useTranslations("signals");
  const [on, setOn] = useState(source.enabled);
  const [busy, setBusy] = useState(false);

  async function toggle(enabled: boolean) {
    setOn(enabled);
    setBusy(true);
    onFailure(undefined);
    try {
      const path = { workspaceId, id: source.id };
      await data(
        browserApi().PATCH("/v1/workspaces/{workspaceId}/signals/sources/{id}", {
          params: { path },
          body: { enabled },
        }),
      );
      await onChange();
    } catch (error) {
      setOn(!enabled);
      onFailure(codeOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Switch
      checked={on}
      disabled={busy}
      aria-label={t("sources.enabled_switch", { label: source.label })}
      onChange={(event) => toggle(event.target.checked)}
    />
  );
}
