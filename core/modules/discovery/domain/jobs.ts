// import_jobs (docs/data.md): the job of an upload, written once its file is read and stored, moved
// by its run (validated, running, then done or failed, with the counts), and read through the tenant
// client of the run around the caller, which scopes every query to its workspace. The counts column
// keeps the run's state: the counts so far, when the run was asked for, the chunks committed, and
// where it stopped once it failed.
import { type TenantClient, tenantClient } from "@whytide/db";
import { z } from "zod";
import {
  type ImportCounts,
  type ImportFailure,
  importCounts,
  importFailure,
  tally,
} from "./import/chunks.ts";
import { type Report, ROW_CODES, type RowError } from "./rows.ts";

export const JOB_STATUSES = [
  "uploaded",
  "validated",
  "invalid",
  "running",
  "done",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** How many jobs the list gives, the newest first. */
export const LIST_LIMIT = 100;

export type ImportJob = {
  readonly id: string;
  readonly workspaceId: string;
  readonly fileKey: string;
  readonly fileName: string;
  readonly status: JobStatus;
  readonly rowCount: number;
  readonly validCount: number;
  readonly errorCount: number;
  readonly report: readonly RowError[];
  /** What the run did; null until it runs. */
  readonly counts: ImportCounts | null;
  /** Where a failed run stopped; null otherwise. */
  readonly failure: ImportFailure | null;
  /** When the run was asked for; null before, and for a job run before alpha-p10-120. */
  readonly startedAt: Date | null;
  /** The run's chunks committed so far: where a retried run goes on. */
  readonly chunks: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
};

const reportRows = z.array(z.strictObject({ row: z.int(), code: z.enum(ROW_CODES) }));
/** The counts column: the run's state, each field after the counts optional for an older run's. */
const countsColumn = z
  .strictObject({
    ...importCounts.shape,
    startedAt: z.iso.datetime().optional(),
    chunks: z.int().nonnegative().optional(),
    failure: importFailure.optional(),
  })
  .nullable();
type Row = Omit<ImportJob, "report" | "counts" | "failure" | "startedAt" | "chunks"> & {
  readonly report: unknown;
  readonly counts: unknown;
};
/** What a run writes in the counts column. */
export type RunState = {
  readonly counts: ImportCounts;
  readonly startedAt: Date | null;
  readonly chunks: number;
  readonly failure?: ImportFailure;
};

/** A validated upload's job: validated with a valid row, invalid without one. */
export async function createImportJob(
  tx: TenantClient,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly fileKey: string;
    readonly fileName: string;
    readonly createdBy: string;
    readonly report: Report;
  },
): Promise<ImportJob> {
  const { report, ...job } = input;
  const row = await tx.importJob.create({
    data: {
      ...job,
      status: report.validCount > 0 ? "validated" : "invalid",
      rowCount: report.rowCount,
      validCount: report.validCount,
      errorCount: report.errorCount,
      report: report.errors.map(({ row, code }) => ({ row, code })),
    },
  });
  return toJob(row);
}

/** The workspace's job with the id, or null. */
export async function findImportJob(id: string): Promise<ImportJob | null> {
  const row = await tenantClient.importJob.findFirst({ where: { id } });
  return row === null ? null : toJob(row);
}

/** The workspace's jobs, the newest first, LIST_LIMIT at most. */
export async function listImportJobs(): Promise<ImportJob[]> {
  const rows = await tenantClient.importJob.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_LIMIT,
  });
  return rows.map(toJob);
}

/**
 * validated to running in one statement, the run's start stamped and its counts at nought: the job,
 * or null when it is not validated, or another run was first.
 */
export async function claimImportJob(
  tx: TenantClient,
  id: string,
  startedAt: Date,
): Promise<ImportJob | null> {
  const [row] = await tx.importJob.updateManyAndReturn({
    where: { id, status: "validated" },
    data: { status: "running", counts: column({ counts: tally([]), startedAt, chunks: 0 }) },
  });
  return row === undefined ? null : toJob(row);
}

/**
 * Locks the running job's row for chunk `index` (1 for the first), until the caller's run ends:
 * false when the job is no longer running or that chunk committed already, in another attempt.
 */
export async function lockChunk(tx: TenantClient, id: string, index: number): Promise<boolean> {
  const { count } = await tx.importJob.updateMany({
    where: { id, status: "running", counts: { path: ["chunks"], equals: index - 1 } },
    data: { status: "running" },
  });
  return count === 1;
}

/** The run's state after a chunk, written in the run of the chunk that made it. */
export async function saveRun(tx: TenantClient, id: string, run: RunState): Promise<void> {
  await tx.importJob.update({ where: { id }, data: { counts: column(run) } });
}

/**
 * The run's end, while the job is running: done with the counts, or failed with where it stopped.
 * The job, or null when it was not running.
 */
export async function endImportJob(
  tx: TenantClient,
  id: string,
  run: RunState,
): Promise<ImportJob | null> {
  const [row] = await tx.importJob.updateManyAndReturn({
    where: { id, status: "running" },
    data: {
      status: run.failure === undefined ? "done" : "failed",
      counts: column(run),
      finishedAt: new Date(),
    },
  });
  return row === undefined ? null : toJob(row);
}

/** The counts column's value: the counts, then the run's state. */
function column({ counts, startedAt, chunks, failure }: RunState) {
  const started = startedAt === null ? {} : { startedAt: startedAt.toISOString() };
  return { ...counts, ...started, chunks, ...(failure === undefined ? {} : { failure }) };
}

function toJob({ report, counts, ...row }: Row): ImportJob {
  const errors = reportRows.parse(report);
  const run = countsColumn.parse(counts);
  if (run === null) {
    return { ...row, report: errors, counts: null, failure: null, startedAt: null, chunks: 0 };
  }
  const { failure = null, startedAt, chunks = 0, ...made } = run;
  const started = startedAt === undefined ? null : new Date(startedAt);
  return { ...row, report: errors, counts: made, failure, startedAt: started, chunks };
}
