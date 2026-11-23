// The import screen in the browser (page.tsx; README.md "The screen"): a card with the file picker,
// a drop zone, beside the expected columns and the sample file; the upload, its size checked first;
// the report of the job it made, with the run under it, which the worker does: the job read every two
// seconds until it ends, or until it looks stuck, when the poll stops; then the counts with View
// leads, the lead list of the job. And the past imports, read here so that their loading and error states show,
// which each answer updates. A failure shows its code in words, with a retry unless the file itself
// must change: in the report once there is a job, else under the picker.
"use client";

import { Button, ErrorState, Link } from "@whytide/ui";
import { CircleX, Download, FileUp, Import, TriangleAlert } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { IMPORT_MAX_BYTES_DEFAULT } from "../../domain/limits.ts";
import { SAMPLE_FILE, SAMPLE_HREF } from "./downloads.ts";
import { History, isStuck, type Job, Report, Result } from "./job.tsx";

const IMPORTS = "/v1/workspaces/{workspaceId}/discovery/imports";
const JOB = "/v1/workspaces/{workspaceId}/discovery/imports/{job}";
const RUN = "/v1/workspaces/{workspaceId}/discovery/imports/{job}/run";
/** How often a running job is read again. */
const POLL_MS = 2_000;
/** The upload's codes that only a changed file answers: no retry for them. */
const FILE_CODES = new Set([
  "import_too_large",
  "import_too_many_rows",
  "import_unsupported_type",
  "import_bad_encoding",
  "import_missing_column",
]);

type Busy = { readonly kind: "uploading"; readonly file: string } | { readonly kind: "running" };
type Problem = { readonly code: string; readonly retry?: () => void };

/** An error answer's code; else internal_error, which ErrorState shows as the generic text. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "internal_error";
}

export function ImportScreen({ workspace }: { workspace: string }) {
  const t = useTranslations("discovery.import");
  const id = useId();
  const [jobs, setJobs] = useState<Job[]>();
  const [listProblem, setListProblem] = useState<string>();
  const [viewer, setViewer] = useState<string>();
  const [job, setJob] = useState<Job>();
  const [busy, setBusy] = useState<Busy>();
  const [problem, setProblem] = useState<Problem>();
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setListProblem(undefined);
    setJobs(undefined);
    try {
      const params = { path: { workspaceId: workspace } };
      const { jobs } = await data(browserApi().GET(IMPORTS, { params }));
      if (open.current) setJobs(jobs);
    } catch (error) {
      if (open.current) setListProblem(codeOf(error));
    }
  }, [workspace]);
  useEffect(() => {
    void load();
    // Who is signed in, for "You" in the past imports; without an answer, no uploader is named.
    browserApi()
      .GET("/v1/me")
      .then(
        ({ data: me }) => {
          if (open.current && me) setViewer(me.user.id);
        },
        () => undefined,
      );
  }, [load]);

  /** The job on the screen, and first in the past imports once they are read. */
  function show(next: Job) {
    setJob(next);
    setJobs((list) => list && [next, ...list.filter((item) => item.id !== next.id)]);
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // so that the same file, picked again, is uploaded again
    if (file) await send(file);
  }

  async function send(file: File) {
    setJob(undefined);
    setProblem(undefined);
    // The api's limit, checked before any request; the api refuses a larger file all the same.
    if (file.size > IMPORT_MAX_BYTES_DEFAULT) return setProblem({ code: "import_too_large" });
    setBusy({ kind: "uploading", file: file.name });
    let code = "internal_error";
    try {
      const body = new FormData();
      body.append("file", file);
      // A multipart route has no body in the api's document, so the client's type takes none;
      // openapi-fetch sends a FormData as it is and leaves its boundary to the browser.
      const params = { path: { workspaceId: workspace } };
      const answer = await browserApi().POST(IMPORTS, { params, body: body as never });
      if (answer.data) return show(answer.data);
      code = codeOf(answer.error);
    } catch {
      // No answer: the network.
    } finally {
      setBusy(undefined);
    }
    setProblem(FILE_CODES.has(code) ? { code } : { code, retry: () => send(file) });
  }

  /** The run's steps, busy meanwhile; a failure is shown with a retry of them all. */
  async function running(steps: () => Promise<void>) {
    setBusy({ kind: "running" });
    setProblem(undefined);
    try {
      await steps();
    } catch (error) {
      setProblem({ code: codeOf(error), retry: () => running(steps) });
    } finally {
      setBusy(undefined);
    }
  }

  const run = (current: Job) =>
    running(async () => {
      const params = { path: { workspaceId: workspace, job: current.id } };
      let started: Job;
      try {
        started = await data(browserApi().POST(RUN, { params }));
      } catch (refused) {
        // Refused, or the answer cut: the job says whether the run started; validated, it did not.
        started = await data(browserApi().GET(JOB, { params }));
        if (started.status === "validated") throw refused;
      }
      show(started);
      // The worker runs it: the job read again until it ends, looks stuck, or the screen closes.
      while (started.status === "running" && !isStuck(started)) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (!open.current) return;
        started = await data(browserApi().GET(JOB, { params }));
        show(started);
      }
    });

  const status =
    busy?.kind === "uploading" ? t("uploading", { file: busy.file }) : busy ? t("running") : "";
  const failure = problem ? (
    <ErrorState module="discovery" code={problem.code} onRetry={problem.retry} />
  ) : null;
  // `discovery-import`: the screen's hook in its specs.
  return (
    <div className="discovery-import grid gap-8">
      <div className="grid gap-6 rounded-xl border border-line bg-surface p-5 shadow-xs lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="grid content-start gap-2">
          <label htmlFor={`${id}-file`} className="font-medium text-ink">
            {t("pick")}
          </label>
          {/* The input covers the zone, unseen: a click anywhere picks, a file dropped on it uploads. */}
          <div className="relative grid justify-items-center gap-2 rounded-xl border-2 border-dashed border-line-strong/50 bg-muted/40 px-6 py-9 text-center transition-colors duration-150 hover:border-accent/60 hover:bg-accent-soft/50 has-[:disabled]:opacity-60 has-[:focus-visible]:border-accent has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-focus/25">
            <span
              aria-hidden="true"
              className="grid size-11 place-items-center rounded-xl bg-surface text-accent-ink shadow-xs ring-1 ring-line"
            >
              <FileUp className="size-5" />
            </span>
            <p className="font-medium text-ink">{t("choose")}</p>
            <p id={`${id}-limit`} className="text-pretty text-xs text-ink-muted">
              {t("limit", { megabytes: IMPORT_MAX_BYTES_DEFAULT / 1_048_576 })}
            </p>
            <input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              aria-describedby={`${id}-limit`}
              disabled={busy !== undefined}
              onChange={upload}
            />
          </div>
          <p role="status" className="flex min-h-5 items-center gap-2 text-sm text-ink-muted">
            {busy ? <span className="wt-spinner" aria-hidden="true" /> : null}
            {status}
          </p>
          {job ? null : failure}
        </div>
        <div className="grid content-start gap-3 rounded-lg bg-muted/60 p-4">
          <p className="text-pretty text-ink-muted">{t("columns")}</p>
          <p className="my-3">
            <Link href={SAMPLE_HREF} download={SAMPLE_FILE}>
              <Download aria-hidden="true" className="me-1.5 inline size-4 align-[-0.2em]" />
              {t("sample")}
            </Link>
          </p>
        </div>
      </div>
      {job ? (
        <Report job={job}>
          {job.status === "validated" ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button variant="primary" loading={busy?.kind === "running"} onClick={() => run(job)}>
                {busy?.kind === "running" ? null : <Import aria-hidden="true" />}
                {t("run")}
              </Button>
            </div>
          ) : null}
          {job.status === "invalid" ? (
            <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3.5 py-3 text-danger-ink">
              <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">{t("none_valid")}</span>
            </p>
          ) : null}
          {isStuck(job) ? (
            <p className="flex items-start gap-2 rounded-lg bg-warm-soft px-3.5 py-3 text-warm-ink">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="text-pretty">{t("stuck")}</span>
            </p>
          ) : null}
          {failure}
        </Report>
      ) : null}
      {job?.counts && job.status !== "running" ? (
        <Result job={job} counts={job.counts} workspace={workspace} />
      ) : null}
      <History
        jobs={jobs}
        problem={listProblem}
        onRetry={load}
        viewer={viewer}
        workspace={workspace}
      />
    </div>
  );
}
