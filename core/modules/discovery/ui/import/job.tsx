// The parts of the import screen (import-screen.tsx) that show a job: the report of its upload, a
// card with its figures, a bar of its valid rows and those with an error, and its error rows to
// download, the run under them; the counts of its run with View leads, the lead list of the job; and
// the past imports, each status a badge in its colour, each with leads its View leads, with their
// loading, error and empty states. Numbers
// and dates go through next-intl's formatter, each code in words. A job running for more than ten
// minutes may be stuck: it says so, and where an administrator finds what to do (docs/runbook.md
// "A job left running").
"use client";

import {
  Badge,
  type BadgeTone,
  ButtonLink,
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  Link,
  Meter,
  Skeleton,
} from "@whytide/ui";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Download,
  FileSpreadsheet,
  FileUp,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
} from "@whytide/ui/icons";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import type { ImportJobResponse } from "../../schemas/imports.ts";
import { HISTORY_LINES, leadsOf } from "./constants.ts";
import { errorRows } from "./downloads.ts";

export type Job = ImportJobResponse;
type Counts = NonNullable<Job["counts"]>;
type Line = Job["errors"][number] & { id: string };

/** How long a run may take before the screen says it may be stuck. */
const STUCK_MS = 10 * 60_000;

/** Running for more than ten minutes, or since before runs had a start (alpha-p10-120). */
export function isStuck(job: Job, now = Date.now()): boolean {
  if (job.status !== "running") return false;
  return job.startedAt === null || now - Date.parse(job.startedAt) > STUCK_MS;
}

/** A figure: the term that names it, its number, and whether a number above zero went wrong. */
type Figure = readonly [term: string, value: number, wrong?: boolean];

/** Counts as a description list of tiles: each number after the term that names it. */
function Figures({ items, wide = false }: { items: readonly Figure[]; wide?: boolean }) {
  const format = useFormatter();
  return (
    <dl
      className={`grid gap-2 ${wide ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "grid-cols-3"}`}
    >
      {items.map(([term, value, wrong]) => (
        <div key={term} className="grid content-start gap-1 rounded-lg bg-muted/60 px-3.5 py-3">
          <dt className="text-xs font-medium text-ink-muted">{term}</dt>
          <dd
            className={`text-2xl font-semibold tracking-tight tabular-nums ${wrong && value > 0 ? "text-danger-ink" : "text-ink"}`}
          >
            {format.number(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A part's icon tile, in the colour of its tone. */
const TILES = {
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success-ink",
  danger: "bg-danger-soft text-danger-ink",
} as const;

/** A part's heading after its icon in a tile of the tone. */
function Heading(props: {
  id: string;
  Icon: LucideIcon;
  tone: keyof typeof TILES;
  children: ReactNode;
}) {
  const { id, Icon, tone, children } = props;
  return (
    <header className="flex items-center gap-3">
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${TILES[tone]}`}>
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <h2 id={id} className="min-w-0 font-semibold text-ink wrap-break-word">
        {children}
      </h2>
    </header>
  );
}

const CARD = "grid gap-5 rounded-xl border border-line bg-surface p-5 shadow-xs";

/** The upload's report: its rows, the valid ones, those with an error, the first errors, then `children`. */
export function Report({ job, children }: { job: Job; children?: ReactNode }) {
  const t = useTranslations("discovery.import");
  const codes = useTranslations("discovery.errors");
  const format = useFormatter();
  const id = useId();
  const words: Record<Line["code"], string> = {
    url_invalid: codes("url_invalid"),
    url_not_linkedin: codes("url_not_linkedin"),
    duplicate_in_file: codes("duplicate_in_file"),
    person_erased: codes("person_erased"),
  };
  const columns: Column<Line>[] = [
    { id: "row", header: t("report.row"), cell: (line) => format.number(line.row) },
    { id: "problem", header: t("report.problem"), cell: (line) => words[line.code] },
  ];
  const figures: Figure[] = [
    [t("report.rows"), job.rowCount],
    [t("report.valid"), job.validCount],
    [t("report.errors"), job.errorCount, true],
  ];
  const download = errorRows(job);
  return (
    <section className={CARD} aria-labelledby={`${id}-title`}>
      <Heading id={`${id}-title`} Icon={FileSpreadsheet} tone="accent">
        {t("report.title", { file: job.fileName })}
      </Heading>
      <div className="grid gap-3">
        <Figures items={figures} />
        <Meter
          max={job.rowCount}
          size="md"
          segments={[
            { value: job.validCount, tone: "accent" },
            { value: job.errorCount, tone: "danger" },
          ]}
        />
      </div>
      {job.errors.length > 0 ? (
        <div className="grid gap-3">
          <DataTable
            caption={t("report.table")}
            columns={columns}
            rows={job.errors.map((line) => ({ ...line, id: `${line.row}` }))}
          />
          <p className="my-3">
            <Link href={download.href} download={download.file}>
              <Download aria-hidden="true" className="me-1.5 inline size-4 align-[-0.2em]" />
              {t("download_errors")}
            </Link>
          </p>
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The run's counts, every data row in one, with View leads, the job's leads; a failed run's code. */
export function Result(props: { job: Job; counts: Counts; workspace: string }) {
  const { job, counts, workspace } = props;
  const t = useTranslations("discovery.import");
  const id = useId();
  const figures: Figure[] = [
    [t("result.created"), counts.created],
    [t("result.updated"), counts.updated],
    [t("result.skipped_duplicate"), counts.skippedDuplicate],
    [t("result.skipped_erased"), counts.skippedErased],
    [t("result.errors"), counts.errors, true],
  ];
  const [Icon, tone] = job.failure
    ? ([CircleAlert, "danger"] as const)
    : ([CircleCheck, "success"] as const);
  return (
    <section className={CARD} aria-labelledby={`${id}-title`}>
      <Heading id={`${id}-title`} Icon={Icon} tone={tone}>
        {t("result.title", { file: job.fileName })}
      </Heading>
      {job.failure ? <ErrorState module="discovery" code={job.failure.code} /> : null}
      <Figures items={figures} wide />
      <div>
        <ButtonLink href={leadsOf(workspace, job.id)} variant="primary">
          {t("view_leads")}
          <ArrowRight aria-hidden="true" className="rtl:-scale-x-100" />
        </ButtonLink>
      </div>
    </section>
  );
}

type HistoryProps = {
  /** The past imports; undefined while they load. */
  jobs: Job[] | undefined;
  /** The code their read failed with. */
  problem: string | undefined;
  onRetry: () => void;
  /** The signed-in user's id, once read: their own jobs say "You". */
  viewer: string | undefined;
  /** The workspace, whose lead list View leads opens. */
  workspace: string;
};

/** Each status's badge: its colour and its icon. */
const LOOKS: Record<Job["status"], [tone: BadgeTone, Icon: LucideIcon]> = {
  uploaded: ["neutral", FileUp],
  validated: ["accent", ListChecks],
  invalid: ["danger", CircleX],
  running: ["accent", LoaderCircle],
  done: ["success", CircleCheck],
  failed: ["danger", CircleAlert],
};

/** The past imports, the newest first, as the api lists them, who uploaded each when it is the viewer. */
export function History({ jobs, problem, onRetry, viewer, workspace }: HistoryProps) {
  const t = useTranslations("discovery.import");
  const format = useFormatter();
  const id = useId();
  const status: Record<Job["status"], string> = {
    uploaded: t("status.uploaded"),
    validated: t("status.validated"),
    invalid: t("status.invalid"),
    running: t("status.running"),
    done: t("status.done"),
    failed: t("status.failed"),
  };
  const badge = (job: Job) => {
    const [tone, Icon] = LOOKS[job.status];
    return (
      <Badge tone={tone}>
        <Icon
          aria-hidden="true"
          className={job.status === "running" ? "motion-safe:animate-spin" : undefined}
        />
        {status[job.status]}
      </Badge>
    );
  };
  const count = (value: number | undefined) => (value === undefined ? null : format.number(value));
  const columns: Column<Job>[] = [
    {
      id: "file",
      header: t("history.file"),
      // Free to wrap at a hyphen: a long name must not make the table wider than its place.
      cell: (job) => job.fileName,
    },
    {
      id: "uploaded",
      header: t("history.uploaded"),
      // The day over the time, each kept on its line.
      cell: ({ createdAt }) => (
        <time dateTime={createdAt} className="grid whitespace-nowrap">
          <span>{format.dateTime(new Date(createdAt), { dateStyle: "medium" })}</span>
          <span>{format.dateTime(new Date(createdAt), { timeStyle: "short" })}</span>
        </time>
      ),
    },
    {
      id: "by",
      header: t("uploaded_by"),
      cell: (job) => (viewer !== undefined && job.createdBy === viewer ? t("history.you") : null),
    },
    {
      id: "status",
      header: t("history.status"),
      cell: (job) => (
        <>
          {badge(job)}
          {/* 10 to 14rem: a block that reads, yet leaves the file and the date their line. */}
          {isStuck(job) ? (
            <span className="mt-1.5 block min-w-40 max-w-56 whitespace-normal text-pretty text-xs text-warm-ink">
              {t("stuck")}
            </span>
          ) : null}
        </>
      ),
    },
    { id: "rows", header: t("report.rows"), cell: (job) => count(job.rowCount) },
    { id: "valid", header: t("report.valid"), cell: (job) => count(job.validCount) },
    { id: "created", header: t("result.created"), cell: (job) => count(job.counts?.created) },
    { id: "updated", header: t("result.updated"), cell: (job) => count(job.counts?.updated) },
    {
      id: "skipped",
      header: t("history.skipped"),
      cell: ({ counts }) => counts && format.number(counts.skippedDuplicate + counts.skippedErased),
    },
    { id: "errors", header: t("result.errors"), cell: (job) => count(job.counts?.errors) },
    {
      id: "leads",
      header: t("history.leads"),
      // A job that brought leads, created or updated: the lead list of them.
      cell: ({ id, fileName, counts }) =>
        counts && counts.created + counts.updated > 0 ? (
          <Link
            href={leadsOf(workspace, id)}
            aria-label={t("history.view_leads_of", { file: fileName })}
          >
            {t("view_leads")}
          </Link>
        ) : null,
    },
  ];
  return (
    <section className="grid gap-4" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="font-semibold text-ink">
        {t("history.title")}
      </h2>
      {problem !== undefined ? (
        <div className="grid gap-3">
          <p className="text-ink">{t("error")}</p>
          <ErrorState module="discovery" code={problem} onRetry={onRetry} />
        </div>
      ) : jobs === undefined ? (
        <div className="grid gap-3">
          <p role="status" className="wt-loading-state">
            <span className="wt-spinner" aria-hidden="true" />
            {t("loading")}
          </p>
          <Skeleton shape="table" lines={HISTORY_LINES} />
        </div>
      ) : (
        <DataTable
          caption={t("history.title")}
          columns={columns}
          rows={jobs}
          empty={<EmptyState message={t("empty")} />}
        />
      )}
    </section>
  );
}
