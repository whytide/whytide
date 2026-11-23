"use client";
// The workspace's sources (README.md "Screen"), a card each, two side by side on a wide screen, the
// one whose runs show marked, by its ring and aria-current: its kind, the label, the enabled switch,
// its target (the post, or that it was erased; the topic's phrase; the own posts; the competitor's
// name and page; the creator's profile, or that it was erased), the sender account with a warning
// and a link to the LinkedIn screen when it is not connected (the source is blocked), the last run
// and whether it stopped at its share of the day's reads, the next fire times (the next one in
// bold), or that it runs daily (gamma-p5-040); a Web research source (gamma-wr-030) has no sender
// account, and shows what it looks for, its region, languages and start pages (links that give no
// referrer, `rel="noopener noreferrer"`), that it runs every N days, and an Edit of those fields;
// while a run is open, its line in words (run-state.tsx) with Stop ("Stopping…" once asked), apart
// from the card's actions: Run now (disabled while a run of it is open, described by that line),
// its runs, View leads (the lead list of the source), for a Web research source its Companies found
// (the screen with the source chosen, gamma-wr-111) and Delete, which asks first. A source imported
// from a CSV file names it (sources-csv-import). Each card names its agent, linked to the agent's
// page, or says it is in none (gamma-p5-045). A change reads the screen again. Another member's
// source, for a member without signals.manage, has its switch off limits and no Run now, Stop or
// Delete, with a hint in their place (README "Decided here").
import { Button, ButtonLink, Dialog, EmptyState, ErrorState, Link, Switch } from "@whytide/ui";
import {
  Bot,
  Building2,
  Clock,
  ExternalLink,
  FileSpreadsheet,
  ListChecks,
  Pencil,
  Play,
  Radar,
  Square,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { foundScreen } from "../found-companies/constants.ts";
import { agentScreen, CONNECTED, leadsOf, linkedinScreen, runStateId } from "./constants.ts";
import { EditResearch } from "./edit-research.tsx";
import { useLanguageName } from "./research-fields.tsx";
import { ResearchPlan } from "./research-plan.tsx";
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
  kind: string;
  label: string;
  config: { [key: string]: unknown };
  /** Null for a source that reads through no LinkedIn account (Web research). */
  senderAccountId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  fireTimes: string[];
  nextRunAt: string | null;
  runOpen: boolean;
  openRun: { id: string; status: "running" | "waiting"; stopRequestedAt: string | null } | null;
  cadence: "daily" | "research" | null;
  /** How many days apart a research source runs; null for the others. */
  everyDays: number | null;
  lastRunBudgetReached: boolean;
  /** The CSV file the source was imported from, while its import is kept. */
  sourceImport: { id: string; fileName: string } | null;
  /** The agent that holds it; null for a source in no agent. */
  playbook: { id: string; name: string } | null;
  /** The member who added it, who writes it. */
  createdBy: string;
};
/** Who is signed in: their user id, and whether they hold signals.manage. */
export type Viewer = { userId: string; manages: boolean };
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
  /** Who is signed in: a source is theirs to write, or every one with signals.manage. */
  viewer: Viewer;
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
  const { workspaceId, sources, accounts, usage, viewer, onChange, onRan, runsOf } = props;
  const t = useTranslations("signals");
  const [failure, setFailure] = useState<string>();
  const [deleting, setDeleting] = useState<Source>();
  const [editing, setEditing] = useState<Source>();
  const languageName = useLanguageName();

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

  const senderOf = (source: Source) =>
    source.senderAccountId === null
      ? undefined
      : accounts.find(({ id }) => id === source.senderAccountId);
  const next = (source: Source) => {
    if (!source.enabled) return t("sources.paused");
    if (source.cadence === "daily") return t("sources.cadence_daily");
    if (source.cadence === "research") {
      return t("sources.cadence_research", { count: source.everyDays ?? 0 });
    }
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
  const kinds: Record<string, string> = {
    post_engagers: t("kinds.post_engagers.label"),
    topic_engagement: t("kinds.topic_engagement.label"),
    competitor_engagement: t("kinds.competitor_engagement.label"),
    creator_engagement: t("kinds.creator_engagement.label"),
    my_post_engagement: t("kinds.my_post_engagement.label"),
    web_research: t("kinds.web_research.label"),
  };
  const text = (source: Source, key: string) => {
    const value = source.config[key];
    return typeof value === "string" ? value : "";
  };
  /** A link out, in a new tab, that gives LinkedIn no address of ours. */
  const external = (href: string, words: string) => (
    <Link href={href} target="_blank" rel="noreferrer">
      {words}
      <ExternalLink
        aria-hidden="true"
        className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
      />
    </Link>
  );
  /**
   * What the source reads: the post, the topic's phrase, the own posts, the competitor's name and
   * page, the creator's profile; a post or a profile emptied by the erasure says so.
   */
  const target = (source: Source) => {
    if (source.kind === "web_research") return <q className="text-ink">{text(source, "focus")}</q>;
    if (source.kind === "topic_engagement")
      return <q className="text-ink">{text(source, "phrase")}</q>;
    if (source.kind === "my_post_engagement") return t("sources.target_own_posts");
    if (source.kind === "competitor_engagement")
      return external(text(source, "companyUrl"), text(source, "companyName"));
    const creator = source.kind === "creator_engagement";
    const url = text(source, creator ? "profileUrl" : "postUrl");
    if (url === "") return t("sources.target_erased");
    return external(url, creator ? url : t("sources.view_post"));
  };

  const list = (source: Source, key: string): string[] => {
    const value = source.config[key];
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  };
  /** A research source's other fields: its region, languages and start pages, when it has them. */
  const research = (source: Source) => {
    const region = text(source, "region");
    const languages = list(source, "languages");
    const pages = list(source, "startPages");
    if (region === "" && languages.length === 0 && pages.length === 0) return null;
    return (
      <dl className="grid gap-4 @md:grid-cols-2">
        {region === "" ? null : (
          <div className="grid content-start gap-1">
            <dt className={TERM}>{t("sources.region")}</dt>
            <dd className="wrap-anywhere text-ink">{region}</dd>
          </div>
        )}
        {languages.length === 0 ? null : (
          <div className="grid content-start gap-1">
            <dt className={TERM}>{t("sources.languages")}</dt>
            <dd className="text-ink">{languages.map(languageName).join(", ")}</dd>
          </div>
        )}
        {pages.length === 0 ? null : (
          <div className="grid content-start gap-1 @md:col-span-2">
            <dt className={TERM}>{t("sources.start_pages")}</dt>
            <dd>
              <ul className="grid gap-1">
                {pages.map((page) => (
                  <li key={page} className="min-w-0 wrap-anywhere">
                    <Link href={page} target="_blank" rel="noopener noreferrer">
                      {page}
                      <ExternalLink
                        aria-hidden="true"
                        className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
    );
  };

  const card = (source: Source) => {
    const sender = senderOf(source);
    const open = source.openRun;
    const heading = `signals-source-${source.id}`;
    const writable = viewer.manages || source.createdBy === viewer.userId;
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
            <span className="text-xs text-ink-muted">{kinds[source.kind] ?? source.kind}</span>
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
              readOnly={!writable}
              onChange={onChange}
              onFailure={setFailure}
            />
          </label>
        </header>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="min-w-0 wrap-break-word text-ink-muted">{target(source)}</span>
          {source.senderAccountId === null ? null : (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-muted">
              <UserRound aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{sender?.label ?? t("sources.account_unknown")}</span>
            </span>
          )}
          {source.sourceImport ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-muted">
              <FileSpreadsheet aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 wrap-anywhere">
                {t("sources.imported_from", { file: source.sourceImport.fileName })}
              </span>
            </span>
          ) : null}
          <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-muted">
            <Bot aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 wrap-anywhere">
              {source.playbook ? (
                <Link href={agentScreen(workspaceId, source.playbook.id)}>
                  {t("sources.agent", { name: source.playbook.name })}
                </Link>
              ) : (
                t("sources.no_agent")
              )}
            </span>
          </span>
        </div>
        {research(source)}
        {source.kind === "web_research" ? (
          <ResearchPlan
            workspaceId={workspaceId}
            sourceId={source.id}
            refreshKey={`${source.lastRunAt ?? ""}|${source.openRun?.id ?? ""}`}
          />
        ) : null}
        {source.senderAccountId === null || sender?.status === CONNECTED ? null : (
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
            {source.lastRunBudgetReached ? (
              <dd className="text-ink-muted">{t("runs.budget_reached")}</dd>
            ) : null}
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
              usage={
                source.senderAccountId === null ? undefined : usage.get(source.senderAccountId)
              }
            />
            {writable ? (
              <StopRun
                key={open.id}
                workspaceId={workspaceId}
                source={source}
                onStopped={onChange}
                onFailure={setFailure}
              />
            ) : null}
          </div>
        ) : null}
        <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {writable ? (
            <RunNow
              workspaceId={workspaceId}
              source={source}
              onRan={onRan}
              onFailure={(code) => {
                setFailure(code);
                if (code !== undefined) void onChange();
              }}
            />
          ) : null}
          <ButtonLink
            href={`?runs=${source.id}`}
            variant="ghost"
            aria-label={t("runs.title", { label: source.label })}
          >
            <ListChecks aria-hidden="true" />
            {t("runs.show")}
          </ButtonLink>
          <ButtonLink
            href={leadsOf(workspaceId, source.id)}
            variant="ghost"
            aria-label={t("sources.view_leads_of", { label: source.label })}
          >
            <Users aria-hidden="true" />
            {t("sources.view_leads")}
          </ButtonLink>
          {source.kind === "web_research" ? (
            <ButtonLink
              href={foundScreen(workspaceId, { source: source.id })}
              variant="ghost"
              aria-label={t("sources.companies_found_of", { label: source.label })}
            >
              <Building2 aria-hidden="true" />
              {t("sources.companies_found")}
            </ButtonLink>
          ) : null}
          {writable && source.kind === "web_research" ? (
            <Button
              variant="ghost"
              aria-label={t("sources.edit_of", { label: source.label })}
              onClick={() => setEditing(source)}
            >
              <Pencil aria-hidden="true" />
              {t("sources.edit")}
            </Button>
          ) : null}
          <span className="ms-auto">
            {writable ? (
              <Button variant="ghost" onClick={() => setDeleting(source)}>
                <Trash2 aria-hidden="true" />
                {t("sources.delete")}
              </Button>
            ) : (
              <span className="text-pretty text-ink-muted text-xs">{t("sources.not_owner")}</span>
            )}
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
      {editing ? (
        <EditResearch
          key={editing.id}
          workspaceId={workspaceId}
          source={editing}
          onClose={() => setEditing(undefined)}
          onSaved={onChange}
        />
      ) : null}
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

/**
 * The enabled switch: it moves at once and back when the api refuses (the limit, say); off limits
 * on another member's source.
 */
function EnabledSwitch(props: {
  workspaceId: string;
  source: Source;
  readOnly: boolean;
  onChange: () => Promise<void>;
  onFailure: (code: string | undefined) => void;
}) {
  const { workspaceId, source, readOnly, onChange, onFailure } = props;
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
      disabled={busy || readOnly}
      aria-label={t("sources.enabled_switch", { label: source.label })}
      onChange={(event) => toggle(event.target.checked)}
    />
  );
}
