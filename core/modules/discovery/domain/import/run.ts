// The import's run (README.md "POST …/imports/{job}/run"; docs/flows.md "Run"). The route claims a
// validated job, running, and publishes discovery.import_run_requested in the request's run; the
// worker's subscriber starts discovery_import_run (workflows/), whose activities call importRows and,
// past its attempts, failImportRun. importRows re-reads the stored file, checks every row with the
// upload's validator and looks the valid URLs up in contacts' hashes in one query; then each chunk of
// 500 valid rows is a run of its own, whose rows, counts so far, chunk number and
// discovery.people_imported commit together. The rows go through contacts' batched commands, a call
// each for the persons and the leads, which merge what another run wrote meanwhile. A retried attempt
// goes on after the last committed chunk, so no chunk is imported twice. No cell leaves the run: the
// job keeps counts and a code, and no line is logged per row.
import {
  errors as contactsErrors,
  createLeadsForPersons,
  isHashed,
  upsertPersonsFromSource,
} from "@whytide/contacts";
import { outboxWriter, type TenantClient, tenantClient } from "@whytide/db";
import { AppError, currentTenant, publish, type TenantContext } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { settings } from "../../settings.ts";
import { readCsv } from "../csv.ts";
import {
  claimImportJob,
  endImportJob,
  findImportJob,
  type ImportJob,
  type JobStatus,
  lockChunk,
  saveRun,
} from "../jobs.ts";
import { RowCheck } from "../rows.ts";
import { inRun } from "../store.ts";
import { chunk, type ImportCounts, outcomeOf, type RowOutcome, tally } from "./chunks.ts";

/** A valid row's values, as contacts' profile takes them. */
type ImportRow = {
  readonly linkedinUrl: string;
  readonly name: string | undefined;
  readonly companyName: string | undefined;
};
/** What the rows' activity answers, kept in Temporal's history: counts, never a cell. */
export type ImportRunResult = { readonly status: JobStatus; readonly counts: ImportCounts | null };
/** How long a chunk's run may take: Prisma's 5 seconds are short for 500 rows on a busy host. */
const CHUNK_TIMEOUT_MS = 60_000;

const commands = { upsertPersonsFromSource, createLeadsForPersons };
let standIns: Partial<typeof commands> = {};

/** For tests (testing/): stand-ins for contacts' commands, to inject a fault; none restores them. */
export function useContactsCommands(next: Partial<typeof commands> = {}): void {
  standIns = next;
}

/**
 * The route's command, in the request's run: the job claimed, running from now, and
 * discovery.import_run_requested in the same transaction, so a failure leaves it validated.
 * import_not_found; import_not_runnable when it is not validated, or another run claimed it first.
 */
export async function requestImportRun(id: string): Promise<ImportJob> {
  const { workspaceId } = currentTenant();
  if ((await findImportJob(id)) === null) throw new AppError(errors.import_not_found);
  const job = await claimImportJob(tenantClient, id, new Date());
  if (job === null) throw new AppError(errors.import_not_runnable);
  const payload = { workspaceId, jobId: id };
  await publish(
    outboxWriter(tenantClient, workspaceId),
    events["discovery.import_run_requested"],
    payload,
  );
  return job;
}

/**
 * The rows' activity: the running job's valid rows imported from the chunk after the last committed
 * one, then the job done with its counts. A job no longer running is answered as it is.
 */
export async function importRows(tenant: TenantContext, id: string): Promise<ImportRunResult> {
  const job = await inRun(tenant, () => findImportJob(id));
  if (job === null) throw new AppError(errors.import_not_found);
  if (job.status !== "running") return { status: job.status, counts: job.counts };
  const { rows, skipped } = await readRows(tenant, job.fileKey);
  const chunks = chunk(rows);
  const urls = chunks.slice(job.chunks).flatMap((rest) => rest.map((row) => row.linkedinUrl));
  const hashed = urls.length ? await inRun(tenant, () => isHashed({ linkedinUrls: urls })) : null;
  const erased = new Set(
    [...(hashed ?? [])].flatMap(([url, kind]) => (kind === "erased" ? [url] : [])),
  );
  let counts = job.chunks > 0 && job.counts ? job.counts : tally(skipped);
  for (let index = job.chunks + 1; index <= chunks.length; index++) {
    counts = await importChunk(tenant, job, index, chunks[index - 1] ?? [], erased, counts);
  }
  const run = { counts, startedAt: job.startedAt, chunks: chunks.length };
  const ended = await inRun(tenant, (tx) => endImportJob(tx, id, run));
  return { status: ended?.status ?? "done", counts };
}

/**
 * Past the rows' attempts: the running job ends failed at the chunk after the last committed one,
 * with the failure's code; an error without one of discovery's or a port's is import_failed.
 */
export async function failImportRun(tenant: TenantContext, id: string, code: string) {
  await inRun(tenant, async (tx) => {
    const job = await findImportJob(id);
    if (job?.status !== "running") return;
    const failure = {
      chunk: job.chunks + 1,
      code: code.startsWith("activity_") ? errors.import_failed : code,
    };
    const counts = job.counts ?? tally([]);
    await endImportJob(tx, id, { counts, startedAt: job.startedAt, chunks: job.chunks, failure });
  });
}

/** The stored file, every row checked as at the upload: the valid rows, the others' buckets. */
async function readRows(tenant: TenantContext, key: string) {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const file = await files.get({ workspaceId: tenant.workspaceId, key });
  const check = new RowCheck();
  const rows: ImportRow[] = [];
  const skipped: RowOutcome[] = [];
  const limits = { maxBytes: settings.IMPORT_MAX_BYTES, maxRows: settings.IMPORT_MAX_ROWS };
  await readCsv(file.body, limits, ({ row, linkedinUrl, name, company }) => {
    const checked = check.add(row, linkedinUrl);
    if ("code" in checked) skipped.push(outcomeOf(checked.code));
    else rows.push({ linkedinUrl: checked.url, name, companyName: company });
  });
  return { rows, skipped };
}

/** Chunk `index` in a run of its own; the counts after it. */
function importChunk(
  tenant: TenantContext,
  job: ImportJob,
  index: number,
  rows: readonly ImportRow[],
  erased: ReadonlySet<string>,
  before: ImportCounts,
): Promise<ImportCounts> {
  const write = (tx: TenantClient) =>
    writeChunk(tx, tenant.workspaceId, job, index, rows, erased, before);
  return inRun(tenant, write, { timeout: CHUNK_TIMEOUT_MS });
}

/**
 * The chunk's rows, then its event and the run's state, in the chunk's run; the job's row locked
 * first, so that a second attempt at the same time imports no chunk twice (import_not_runnable).
 */
async function writeChunk(
  tx: TenantClient,
  workspaceId: string,
  job: ImportJob,
  index: number,
  rows: readonly ImportRow[],
  erased: ReadonlySet<string>,
  before: ImportCounts,
): Promise<ImportCounts> {
  if (!(await lockChunk(tx, job.id, index))) throw new AppError(errors.import_not_runnable);
  const { outcomes, personIds } = await writeRows(job, rows, erased);
  if (personIds.length > 0) {
    const payload = { workspaceId, jobId: job.id, personIds };
    await publish(outboxWriter(tx, workspaceId), events["discovery.people_imported"], payload);
  }
  const counts = tally(outcomes, before);
  await saveRun(tx, job.id, { counts, startedAt: job.startedAt, chunks: index });
  return counts;
}

/**
 * The chunk's rows: their persons in one call of contacts' batched command, their values stamped
 * with the upload's time, then the leads of those written, from this job, in another. A person
 * erased since the check, or a cell over contacts' limits, is the row's bucket, not a failure. The
 * outcomes, and the persons written in the rows' order.
 */
async function writeRows(
  job: ImportJob,
  rows: readonly ImportRow[],
  erased: ReadonlySet<string>,
): Promise<{ outcomes: RowOutcome[]; personIds: string[] }> {
  const { upsertPersonsFromSource: upsert, createLeadsForPersons: createLeads } = {
    ...commands,
    ...standIns,
  };
  const fresh = rows.filter((row) => !erased.has(row.linkedinUrl));
  const profiles = fresh.map((row) => ({ ...row, fetchedAt: job.createdAt }));
  const answers = await upsert(
    profiles.map((profile) => ({ source: "import" as const, provider: "csv" as const, profile })),
  );
  const outcomes = new Array<RowOutcome>(rows.length - fresh.length).fill("skippedErased");
  const written: { id: string; created: boolean }[] = [];
  for (const answer of answers) {
    if ("person" in answer) written.push({ id: answer.person.id, created: answer.created });
    else outcomes.push(answer.code === contactsErrors.person_erased ? "skippedErased" : "errors");
  }
  const source = { kind: "imported" as const, ref: job.id };
  if (written.length > 0) await createLeads(written.map(({ id }) => ({ personId: id, source })));
  for (const { created } of written) outcomes.push(created ? "created" : "updated");
  return { outcomes, personIds: written.map(({ id }) => id) };
}
