"use client";
// The runs panel of one source (README.md "Screen"), read in the browser with its loading state and
// its error state with a retry: each run's status as a badge in its colour, start, end, counts (a
// posts kind's posts read too) and drops by reason, a failed run's end code in words, a done one that
// stopped at its share of the day's reads (gamma-p5-040), and for a waiting one when it reads again:
// the next start of its sender account's working hours (linkedin's usage, `nextWindowAt`), where a
// refusal for the hours or for the day's cap both end, shown in the account's time zone.
import {
  Badge,
  type BadgeTone,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  Skeleton,
  useErrorText,
} from "@whytide/ui";
import {
  Ban,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  Clock,
  History,
  LoaderCircle,
  type LucideIcon,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { SKELETON } from "./constants.ts";
import type { Account, Source } from "./source-list.tsx";
import { FORMAT, When } from "./when.tsx";

type Status = "scheduled" | "running" | "waiting" | "done" | "failed" | "cancelled";
type Run = {
  id: string;
  status: Status;
  startedAt: string | null;
  finishedAt: string | null;
  counts: { [name: string]: unknown };
  error: string | null;
};
type Loaded = { readonly runs: Run[]; readonly resumesAt: string | undefined };
type Props = { workspaceId: string; source: Source; sender: Account | undefined };

/** The drops in the order a run makes them (README.md "Processing"); a name not here comes last. */
const DROPS = [
  "dropped_company",
  "dropped_own",
  "dropped_recruiter",
  "dropped_job_seeker",
  "dropped_competitor",
  "dropped_hashed",
  "dropped_known",
  "dropped_triage",
  "dropped_filtered",
  "dropped_unread",
];
/** Each status's badge: its colour and its icon. */
const LOOKS: Record<Status, [tone: BadgeTone, Icon: LucideIcon]> = {
  scheduled: ["neutral", CalendarClock],
  running: ["accent", LoaderCircle],
  waiting: ["warning", Clock],
  done: ["success", CircleCheck],
  failed: ["danger", CircleAlert],
  cancelled: ["neutral", Ban],
};
const count = (value: unknown) => (typeof value === "number" ? value : 0);
const rank = (name: string) => (DROPS.includes(name) ? DROPS.indexOf(name) : DROPS.length);

export function RunsPanel({ workspaceId, source, sender }: Props) {
  const t = useTranslations("signals");
  const format = useFormatter();
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<string>();
  const senderId = sender?.id;

  const load = useCallback(async () => {
    setFailure(undefined);
    setLoaded(undefined);
    try {
      const api = browserApi();
      const { runs } = await data(
        api.GET("/v1/workspaces/{workspaceId}/signals/sources/{id}/runs", {
          params: { path: { workspaceId, id: source.id } },
        }),
      );
      const waiting = runs.some((run) => run.status === "waiting");
      const usage =
        waiting && senderId !== undefined
          ? await data(
              api.GET("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/usage", {
                params: { path: { workspaceId, id: senderId } },
              }),
            )
          : undefined;
      setLoaded({ runs, resumesAt: usage?.nextWindowAt });
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    }
  }, [workspaceId, source.id, senderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const status: Record<Status, string> = {
    scheduled: t("runs.status.scheduled"),
    running: t("runs.status.running"),
    waiting: t("runs.status.waiting"),
    done: t("runs.status.done"),
    failed: t("runs.status.failed"),
    cancelled: t("runs.status.cancelled"),
  };
  /** The end codes of other modules a run fails with, in signals' words. */
  const ends: Record<string, string> = {
    linkedin_account_disconnected: t("errors.linkedin_account_disconnected"),
    insufficient_credits: t("errors.insufficient_credits"),
    activity_failed: t("errors.activity_failed"),
    linkedin_rate_limited: t("errors.linkedin_rate_limited"),
    linkedin_provider_error: t("errors.linkedin_provider_error"),
    linkedin_error_unmapped: t("errors.linkedin_error_unmapped"),
    linkedin_not_found: t("errors.linkedin_not_found"),
    platform_stopped: t("errors.platform_stopped"),
    workspace_stopped: t("errors.workspace_stopped"),
    account_stopped: t("errors.account_stopped"),
    account_paused: t("errors.account_paused"),
  };
  const detail = (run: Run) => {
    if (run.status === "failed") {
      if (!run.error) return t("runs.error_other");
      return ends[run.error] ?? <RunError code={run.error} />;
    }
    if (run.status === "done" && count(run.counts.adapters_spent) > 0) {
      return t("runs.research_adapters_spent");
    }
    if (run.status === "done" && count(run.counts.budget_reached) > 0) {
      return isResearch(run) ? t("runs.research_budget_reached") : t("runs.budget_reached");
    }
    const resumesAt = loaded?.resumesAt;
    if (run.status === "waiting" && resumesAt !== undefined && sender) {
      const at = format.dateTime(new Date(resumesAt), { ...FORMAT, timeZone: sender.timeZone });
      return t.rich("runs.waiting_until", {
        at,
        time: (chunks) => <time dateTime={resumesAt}>{chunks}</time>,
      });
    }
    return null;
  };
  /** A research run's counts hold the plan's; a LinkedIn run's never do. */
  const isResearch = (run: Run) => run.counts.queries_planned !== undefined;
  const researchCounts = (run: Run) => (
    <span className="grid gap-0.5">
      <span className="whitespace-nowrap">
        {t("runs.research_counts", {
          planned: count(run.counts.queries_planned),
          asked: count(run.counts.searches_asked),
          results: count(run.counts.search_results),
        })}
      </span>
      {count(run.counts.searches_failed) > 0 ? (
        <span className="whitespace-nowrap">
          {t("runs.research_failed", { failed: count(run.counts.searches_failed) })}
        </span>
      ) : null}
    </span>
  );
  const counts = (run: Run) =>
    Object.keys(run.counts).length === 0 ? null : isResearch(run) ? (
      researchCounts(run)
    ) : (
      <span className="grid gap-0.5">
        {typeof run.counts.posts === "number" ? (
          <span className="whitespace-nowrap">{t("runs.posts", { posts: run.counts.posts })}</span>
        ) : null}
        <span className="whitespace-nowrap">
          {t("runs.counts", {
            staged: count(run.counts.staged),
            created: count(run.counts.created),
          })}
        </span>
        {count(run.counts.rated) > 0 ? (
          <span className="whitespace-nowrap">
            {t("runs.rated", { rated: count(run.counts.rated) })}
          </span>
        ) : null}
        {count(run.counts.unrated) > 0 ? (
          <span className="whitespace-nowrap">
            {t("runs.unrated", { unrated: count(run.counts.unrated) })}
          </span>
        ) : null}
      </span>
    );
  const drops = (run: Run) => {
    const names = Object.keys(run.counts)
      .filter((name) => name.startsWith("dropped_") && count(run.counts[name]) > 0)
      .sort((a, b) => rank(a) - rank(b));
    if (names.length === 0) return null;
    return (
      <ul className="grid gap-0.5 text-xs">
        {names.map((name) => (
          <li key={name}>{t("runs.drops", { reason: name, count: count(run.counts[name]) })}</li>
        ))}
      </ul>
    );
  };
  const time = (at: string | null) => (at ? <When at={at} stacked /> : null);
  const badge = (run: Run) => {
    const [tone, Icon] = LOOKS[run.status];
    return (
      <Badge tone={tone}>
        <Icon
          aria-hidden="true"
          className={run.status === "running" ? "motion-safe:animate-spin" : undefined}
        />
        {status[run.status]}
      </Badge>
    );
  };
  const title = t("runs.title", { label: source.label });

  return (
    <section aria-labelledby="signals-runs" className="grid gap-4">
      <header className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-ink-muted">
          <History aria-hidden="true" className="size-4.5" />
        </span>
        <h2 id="signals-runs" className="min-w-0 font-semibold text-ink">
          {title}
        </h2>
      </header>
      {failure !== undefined ? (
        <ErrorState module="signals" code={failure} onRetry={load} />
      ) : loaded === undefined ? (
        <div className="grid gap-3">
          <LoadingState />
          <Skeleton shape="table" lines={SKELETON.runRows} />
        </div>
      ) : (
        <DataTable
          caption={title}
          rows={loaded.runs}
          empty={<EmptyState message={t("runs.empty")} />}
          columns={[
            {
              id: "status",
              header: t("runs.status_label"),
              cell: badge,
            },
            { id: "started", header: t("runs.started"), cell: (run) => time(run.startedAt) },
            { id: "finished", header: t("runs.finished"), cell: (run) => time(run.finishedAt) },
            { id: "counts", header: t("runs.counts_label"), cell: counts },
            { id: "drops", header: t("runs.drops_label"), cell: drops },
            { id: "detail", header: t("runs.detail"), cell: detail },
          ]}
        />
      )}
    </section>
  );
}

/** A failed run's own code in words (signal_post_not_found): signals' key, else the generic text. */
function RunError({ code }: { code: string }) {
  return useErrorText("signals", code);
}
