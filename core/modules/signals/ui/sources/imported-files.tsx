"use client";
// The sources screen's Imported files (README.md "Screen"), below the LinkedIn sources: discovery's
// imports, read in the browser through the web's API client (signals never imports discovery), and
// signals' own imports of sources (sources-csv-import), the newest first, with their own loading
// state, error state with a retry, naming the module whose read failed, and empty state, which links
// to the Import screen. A card per job that ran, in the source cards' style: its kind, the file, the
// upload's day and time, who uploaded it ("You" for the viewer's own, from GET /v1/me), its status as
// a badge, what it imported and skipped (duplicates and erased people, as the Import screen), its
// errors when any, and View leads, the lead list of that job; a card per import of sources: the file,
// the upload, who, the sources created, those created disabled and the rows not imported, when any.
// Then a link to import another.
import {
  Badge,
  type BadgeTone,
  ButtonLink,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@whytide/ui";
import {
  CircleAlert,
  CircleCheck,
  FileSpreadsheet,
  FileUp,
  LoaderCircle,
  type LucideIcon,
  Radar,
  Users,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { importScreen, leadsOf, RAN, type Ran } from "./constants.ts";

/** An import as discovery's `GET …/discovery/imports` answers it: the fields the card shows. */
type Job = {
  id: string;
  fileName: string;
  status: string;
  counts: {
    created: number;
    updated: number;
    skippedDuplicate: number;
    skippedErased: number;
    errors: number;
  } | null;
  createdBy: string;
  createdAt: string;
};
type Shown = Job & { status: Ran };
/** An import of sources as signals' `GET …/signals/sources/imports` answers it. */
type SourceImport = {
  id: string;
  fileName: string;
  createdBy: string;
  createdAt: string;
  created: number;
  disabled: number;
  refused: number;
};
/** A card of the list: a job's or an import of sources'. */
type Entry =
  | { readonly of: "leads"; readonly job: Shown }
  | { readonly of: "sources"; readonly sourceImport: SourceImport };
/** A read that failed: the module whose list it was, and the code. */
type Failure = { readonly module: "discovery" | "signals"; readonly code: string };

/** Each status's badge: its colour and its icon. */
const LOOKS: Record<Ran, [tone: BadgeTone, Icon: LucideIcon]> = {
  done: ["success", CircleCheck],
  running: ["accent", LoaderCircle],
  failed: ["danger", CircleAlert],
};
/** A fact of a card: its name over its value, as the source cards'. */
const TERM = "text-xs font-medium text-ink-muted";
const ran = (job: Job): job is Shown => (RAN as readonly string[]).includes(job.status);
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const createdAt = (entry: Entry) =>
  entry.of === "leads" ? entry.job.createdAt : entry.sourceImport.createdAt;

export function ImportedFiles({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("signals.imports");
  const [jobs, setJobs] = useState<Entry[]>();
  const [failure, setFailure] = useState<Failure>();
  const [viewer, setViewer] = useState<string>();

  const load = useCallback(async () => {
    setFailure(undefined);
    setJobs(undefined);
    const params = { path: { workspaceId } };
    const api = browserApi();
    const [leads, sources] = await Promise.allSettled([
      data(api.GET("/v1/workspaces/{workspaceId}/discovery/imports", { params })),
      data(api.GET("/v1/workspaces/{workspaceId}/signals/sources/imports", { params })),
    ]);
    if (leads.status === "rejected") {
      return setFailure({ module: "discovery", code: codeOf(leads.reason) });
    }
    if (sources.status === "rejected") {
      return setFailure({ module: "signals", code: codeOf(sources.reason) });
    }
    const listed: Job[] = leads.value.jobs;
    const entries: Entry[] = [
      ...listed.filter(ran).map((job) => ({ of: "leads" as const, job })),
      ...sources.value.imports.map((sourceImport) => ({ of: "sources" as const, sourceImport })),
    ];
    // ISO times: their order as text is their order in time.
    setJobs(entries.sort((a, b) => (createdAt(a) < createdAt(b) ? 1 : -1)));
  }, [workspaceId]);

  useEffect(() => {
    void load();
    // Who is signed in, for "You"; without an answer, no uploader is named.
    browserApi()
      .GET("/v1/me")
      .then(
        ({ data: me }) => me && setViewer(me.user.id),
        () => undefined,
      );
  }, [load]);

  const add = (
    <ButtonLink href={importScreen(workspaceId)}>
      <FileUp aria-hidden="true" />
      {t("import")}
    </ButtonLink>
  );
  return (
    <section aria-labelledby="signals-imports" className="grid gap-4">
      <h2 id="signals-imports" className="font-semibold text-ink">
        {t("title")}
      </h2>
      {failure !== undefined ? (
        <div className="grid gap-3">
          <p className="text-ink">{t("error")}</p>
          <ErrorState module={failure.module} code={failure.code} onRetry={load} />
        </div>
      ) : jobs === undefined ? (
        <div aria-busy="true">
          <LoadingState />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState message={t("empty")} action={<div>{add}</div>} />
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {jobs.map((entry) =>
              entry.of === "leads" ? (
                <ImportCard
                  key={entry.job.id}
                  workspaceId={workspaceId}
                  job={entry.job}
                  viewer={viewer}
                />
              ) : (
                <SourceImportCard
                  key={entry.sourceImport.id}
                  sourceImport={entry.sourceImport}
                  viewer={viewer}
                />
              ),
            )}
          </div>
          <div>{add}</div>
        </>
      )}
    </section>
  );
}

function ImportCard(props: { workspaceId: string; job: Shown; viewer: string | undefined }) {
  const { workspaceId, job, viewer } = props;
  const t = useTranslations("signals.imports");
  const format = useFormatter();
  const heading = `signals-import-${job.id}`;
  const [tone, Icon] = LOOKS[job.status];
  const status = {
    done: t("status.done"),
    running: t("status.running"),
    failed: t("status.failed"),
  };
  const { counts } = job;
  const uploader =
    viewer === undefined ? null : job.createdBy === viewer ? t("you") : t("teammate");
  const at = new Date(job.createdAt);
  return (
    <article
      aria-labelledby={heading}
      className="@container flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <FileSpreadsheet aria-hidden="true" className="size-4.5" />
        </span>
        <div className="grid min-w-0 flex-1">
          <span className="text-xs text-ink-muted">{t("kind")}</span>
          <h3 id={heading} className="text-pretty font-semibold text-ink wrap-break-word">
            {job.fileName}
          </h3>
        </div>
        <span className="shrink-0">
          <Badge tone={tone}>
            <Icon
              aria-hidden="true"
              className={job.status === "running" ? "motion-safe:animate-spin" : undefined}
            />
            {status[job.status]}
          </Badge>
        </span>
      </header>
      <dl className="grid grid-cols-2 gap-4 @md:grid-cols-4">
        <div className="grid content-start gap-1">
          <dt className={TERM}>{t("uploaded")}</dt>
          <dd className="text-ink">
            <time dateTime={job.createdAt} className="grid">
              <span>{format.dateTime(at, { dateStyle: "medium" })}</span>
              <span className="text-ink-muted">{format.dateTime(at, { timeStyle: "short" })}</span>
            </time>
          </dd>
        </div>
        <div className="grid content-start gap-1">
          <dt className={TERM}>{t("uploaded_by")}</dt>
          <dd className="text-ink">{uploader}</dd>
        </div>
        {counts ? (
          <>
            <div className="grid content-start gap-1">
              <dt className={TERM}>{t("imported")}</dt>
              <dd className="text-ink tabular-nums">
                {format.number(counts.created + counts.updated)}
              </dd>
            </div>
            <div className="grid content-start gap-1">
              <dt className={TERM}>{t("skipped")}</dt>
              <dd className="text-ink tabular-nums">
                {format.number(counts.skippedDuplicate + counts.skippedErased)}
              </dd>
            </div>
            {counts.errors > 0 ? (
              <div className="grid content-start gap-1">
                <dt className={TERM}>{t("errors")}</dt>
                <dd className="text-danger-ink tabular-nums">{format.number(counts.errors)}</dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
      <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <ButtonLink
          href={leadsOf(workspaceId, job.id)}
          variant="ghost"
          aria-label={t("view_leads_of", { file: job.fileName })}
        >
          <Users aria-hidden="true" />
          {t("view_leads")}
        </ButtonLink>
      </footer>
    </article>
  );
}

/** An import of sources: the file, the upload, who, and the sources it created and the rows it left. */
function SourceImportCard(props: { sourceImport: SourceImport; viewer: string | undefined }) {
  const { sourceImport, viewer } = props;
  const t = useTranslations("signals.imports");
  const format = useFormatter();
  const heading = `signals-import-${sourceImport.id}`;
  const uploader =
    viewer === undefined ? null : sourceImport.createdBy === viewer ? t("you") : t("teammate");
  const at = new Date(sourceImport.createdAt);
  const counts: [term: string, value: number, shown: boolean][] = [
    [t("created"), sourceImport.created, true],
    [t("disabled"), sourceImport.disabled, sourceImport.disabled > 0],
    [t("refused"), sourceImport.refused, sourceImport.refused > 0],
  ];
  return (
    <article
      aria-labelledby={heading}
      className="@container flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink">
          <Radar aria-hidden="true" className="size-4.5" />
        </span>
        <div className="grid min-w-0 flex-1">
          <span className="text-xs text-ink-muted">{t("sources_kind")}</span>
          <h3 id={heading} className="text-pretty font-semibold text-ink wrap-break-word">
            {sourceImport.fileName}
          </h3>
        </div>
      </header>
      <dl className="grid grid-cols-2 gap-4 @md:grid-cols-4">
        <div className="grid content-start gap-1">
          <dt className={TERM}>{t("uploaded")}</dt>
          <dd className="text-ink">
            <time dateTime={sourceImport.createdAt} className="grid">
              <span>{format.dateTime(at, { dateStyle: "medium" })}</span>
              <span className="text-ink-muted">{format.dateTime(at, { timeStyle: "short" })}</span>
            </time>
          </dd>
        </div>
        <div className="grid content-start gap-1">
          <dt className={TERM}>{t("uploaded_by")}</dt>
          <dd className="text-ink">{uploader}</dd>
        </div>
        {counts.map(([term, value, shown]) =>
          shown ? (
            <div key={term} className="grid content-start gap-1">
              <dt className={TERM}>{term}</dt>
              <dd className="text-ink tabular-nums">{format.number(value)}</dd>
            </div>
          ) : null,
        )}
      </dl>
    </article>
  );
}
