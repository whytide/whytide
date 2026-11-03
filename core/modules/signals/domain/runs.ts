// A source's runs as the worker drives them (README.md "Runs"; docs/flows.md): each function is one
// step of the run workflow's, called in an activity's own tenant run (context.tenant), on its
// transaction (tenantClient). The read quota and the credits are reserved and settled in steps of
// their own, never around the provider's read, which is linkedin's activity; a refusal is an answer
// the workflow waits on or ends with. The run's files are read and deleted outside any run.
import { json } from "node:stream/consumers";
import { outboxWriter, tenantClient } from "@whytide/db";
import {
  commitReads,
  findSenderAccount,
  errors as linkedinErrors,
  releaseReads,
  reserveReads,
} from "@whytide/linkedin";
import {
  credits,
  creditsCodes,
  isAppError,
  newId,
  publish,
  type ReserveInput,
} from "@whytide/platform";
import { filesConfig, filesPort, getAdapter, linkedinPort } from "@whytide/providers";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import { signalsMetrics } from "../metrics.ts";
import { prices } from "../prices.ts";
import { settings } from "../settings.ts";
import { sourceKind } from "../sources/registry.ts";
import { ENGAGERS_PER_READ, engagerCreditKeyOf } from "./constants.ts";
import { runFolder } from "./process/keys.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Engagers per credit (prices.ts). */
const ENGAGERS_PER_BLOCK = 30;

/** A run as its steps name it: ids only. */
export type RunRef = {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly runId: string;
};
export type RunStart =
  | { readonly status: "gone" }
  | { readonly status: "blocked" }
  | {
      readonly status: "started";
      readonly accountId: string;
      /** The kind's provider activity, and its input from the config: the post's URL. */
      readonly reader: string;
      readonly readerInput: Readonly<Record<string, string>>;
      readonly pageSize: number;
      /**
       * A block's credits: SIGNALS_ESTIMATED_PAGES pages of engagers, in blocks of 30; read only by
       * a run started before beta-p1-090.
       */
      readonly quantity: number;
      /** Engaged before it is not new: the watermark, or the lookback's start. */
      readonly cutAt: string;
    };
export type ReadReservation =
  | { readonly reservationId: string }
  | { readonly refused: string; readonly retryAt: string | null };
type Refused = { readonly refused: typeof creditsCodes.insufficient_credits };
/** A block of credits: with the blocks billed before it, it pays for the engagers read up to `until`. */
export type CreditsReservation = { readonly usageId: string; readonly until: number } | Refused;
/** A candidate's credit, reserved for its profile read (beta-p1-090). */
export type EngagerCredit = { readonly usageId: string } | Refused;
export type StagedPage = { readonly reachedCut: boolean; readonly newest: string | null };
export type RunEnd =
  | { readonly status: "done"; readonly newest?: string | undefined }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "cancelled" };
/** The run's open block of credits, if any, the engagers read and the blocks billed so far. */
export type RunUsage = {
  readonly usageId?: string | undefined;
  readonly read: number;
  readonly billed: number;
};

/** The quantity of `engagers`: blocks of 30, rounded up, as credits do not round. */
export const blocksOf = (engagers: number): number => Math.ceil(engagers / ENGAGERS_PER_BLOCK);

/** Where reading stops: the watermark's `engagedAt`, or the lookback before `now` when later. */
export function cutOf(watermark: unknown, lookbackDays: number, now: Date): Date {
  const lookback = now.getTime() - lookbackDays * DAY_MS;
  const mark = (watermark as { engagedAt?: unknown } | null)?.engagedAt;
  const at = typeof mark === "string" ? Date.parse(mark) : Number.NaN;
  return new Date(Number.isNaN(at) ? lookback : Math.max(at, lookback));
}

/**
 * The first step: the run's row made (a scheduled run) or found as run now wrote it, with the id of
 * the workflow that runs it, `workflowId`, `running` from now, and the source's last_run_at now. A
 * source gone starts nothing; a run whose stop was asked before it started ends `cancelled` here and
 * starts nothing either (fix-run-stop); a sender account that is not connected, or gone, blocks it.
 */
export async function startRun(
  ref: RunRef,
  workflowId: string,
  now = new Date(),
): Promise<RunStart> {
  const { workspaceId, sourceId, runId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return { status: "gone" };
  const kind = sourceKind(source.kind);
  const row = { id: runId, workspaceId, sourceId: source.id, workflowId };
  await tenantClient.signalRun.createMany({ data: [row], skipDuplicates: true });
  const started = await tenantClient.signalRun.updateMany({
    where: { id: runId, status: "scheduled", stopRequestedAt: null },
    data: { status: "running", startedAt: now, workflowId },
  });
  // Not started: stopped before (a stop that commits meanwhile is waited for and seen here), or a
  // retry of this step, which finds the row as the first attempt left it.
  if (started.count === 0) {
    const stopped = await tenantClient.signalRun.updateMany({
      where: { id: runId, status: "scheduled", stopRequestedAt: { not: null } },
      data: { status: "cancelled", finishedAt: now, workflowId },
    });
    if (stopped.count > 0)
      signalsMetrics["signals.runs"].add(1, { outcome: "cancelled", code: "none" });
    const found = await tenantClient.signalRun.findFirst({ where: { id: runId } });
    if (found?.status === "cancelled" && found.startedAt === null) return { status: "gone" };
  }
  await tenantClient.signalSource.update({ where: { id: source.id }, data: { lastRunAt: now } });
  const account = await findSenderAccount(source.senderAccountId).catch((error: unknown) => {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  });
  if (account?.status !== "connected") return { status: "blocked" };
  const { reader } = kind;
  return {
    status: "started",
    accountId: account.id,
    reader: reader.activity,
    readerInput: reader.input(source.config),
    pageSize: reader.pageSize,
    quantity: blocksOf(settings.SIGNALS_ESTIMATED_PAGES * reader.pageSize),
    cutAt: cutOf(source.watermark, kind.lookbackDays, now).toISOString(),
  };
}

/**
 * One read reserved, a page's or a profile's, the run `running` again after a wait; refused for the
 * cap or the hours, the run `waiting` until `retryAt`; refused with `retryAt` null, the account is not
 * connected.
 */
export async function reserveRead(
  { runId }: RunRef,
  accountId: string,
  kind: "read_engagers" | "read_profile" = "read_engagers",
): Promise<ReadReservation> {
  const reserved = await reserveReads({ accountId, count: 1, kind });
  if ("refused" in reserved) {
    const { refused, retryAt } = reserved;
    if (retryAt !== null) await setStatus(runId, "running", "waiting");
    return { refused, retryAt: retryAt?.toISOString() ?? null };
  }
  await setStatus(runId, "waiting", "running");
  return { reservationId: reserved.reservationId };
}

/** The page's read made, whatever it answered, or not made: the read failed. */
export async function settleRead(reservationId: string, made: boolean): Promise<void> {
  if (made) await commitReads(reservationId, 1);
  else await releaseReads(reservationId);
}

/**
 * A block of `quantity` credits, `sigrun:<runId>` first, then `sigrun:<runId>:<n>`, for a run started
 * before beta-p1-090 only: reserved before the first read, once the next page could pass what the
 * blocks pay for, and after a wait. With the `billed` blocks committed before it, it pays for the
 * engagers read up to `until`.
 */
export async function reserveCredits(
  { workspaceId, runId }: RunRef,
  attempt: number,
  quantity: number,
  billed: number,
): Promise<CreditsReservation> {
  const idempotencyKey = attempt === 1 ? `sigrun:${runId}` : `sigrun:${runId}:${attempt}`;
  const action = prices["signals.engager_read"];
  const reserve = { workspaceId, action, quantity, idempotencyKey, subjectRef: runId };
  const reserved = await reserveOrRefuse({ ...reserve, lease: "async" });
  if ("refused" in reserved) return reserved;
  return { usageId: reserved.usageId, until: (billed + quantity) * ENGAGERS_PER_BLOCK };
}

/**
 * A credit for a candidate's profile read, after its read slot and before the read (beta-p1-090): one
 * engager of `signals.engager`, keyed `sigprof:<runId>:<candidateId>:<n>`, its subject the candidate,
 * as the person is known only once the read is processed; the 24-hour lease, which a settle right
 * after the read never outlives. A retried step finds its key's row and charges once.
 */
export async function reserveEngagerCredit(
  { workspaceId, runId }: RunRef,
  candidateId: string,
  n: number,
): Promise<EngagerCredit> {
  return reserveOrRefuse({
    workspaceId,
    action: prices["signals.engager"],
    quantity: ENGAGERS_PER_READ,
    idempotencyKey: engagerCreditKeyOf(runId, candidateId, n),
    subjectRef: candidateId,
    lease: "async",
  });
}

/** A candidate's credit settled: committed when the read returned the profile, released otherwise. */
export async function settleEngagerCredit(usageId: string, read: boolean): Promise<void> {
  if (read) await credits.commit(usageId);
  else await credits.release(usageId);
}

/** The reservation, or the refusal of a short balance, which the workflow ends the reading on. */
async function reserveOrRefuse(input: ReserveInput): Promise<{ usageId: string } | Refused> {
  try {
    const { usageId } = await credits.reserve(input);
    return { usageId };
  } catch (error) {
    const insufficient = isAppError(error) && error.code === creditsCodes.insufficient_credits;
    if (insufficient) return { refused: creditsCodes.insufficient_credits };
    throw error;
  }
}

/**
 * The open block settled: the blocks of the engagers `read` not `billed` yet committed on it, the
 * rest released, all of it when none is owed. The blocks billed after it. Before a wait, so that no
 * wait outlives the 24-hour lease, before the next block, and at the run's end.
 */
export async function settleCredits(usageId: string, read: number, billed: number) {
  const owed = blocksOf(read) - billed;
  if (owed > 0) await credits.commit(usageId, owed);
  else await credits.release(usageId);
  return { billed: billed + Math.max(owed, 0) };
}

/** A page file the reader wrote, read outside any run: the store is another process. */
export async function readPageFile(workspaceId: string, key: string): Promise<unknown> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return json((await files.get({ workspaceId, key })).body);
}

/**
 * A page's candidates from the cut on staged, once per member and reaction in the run, and the run's
 * counts as of the page: `pages`, `read` (the engagers the provider answered), `staged`, and
 * `created`, 0 until the processing adds to it (addCounts). A source gone ends the reading.
 */
export async function stagePage(
  { workspaceId, sourceId, runId }: RunRef,
  page: {
    readonly number: number;
    readonly key: string;
    readonly cutAt: string;
    readonly read: number;
  },
  file: unknown,
): Promise<StagedPage> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return { reachedCut: true, newest: null };
  const kind = sourceKind(source.kind);
  const read = kind.reader.page(file, source.config, new Date(page.cutAt));
  const data = read.candidates.map(({ objectUrl: _object, commentText, ...candidate }) => ({
    ...candidate,
    id: newId(ids.signal_candidate),
    workspaceId,
    runId,
    commentText: commentText ?? null,
    rawRef: page.key,
  }));
  const { count } = await tenantClient.signalCandidate.createMany({ data, skipDuplicates: true });
  signalsMetrics["signals.candidates"].add(count, { kind: kind.kind });
  const staged = await tenantClient.signalCandidate.count({ where: { runId } });
  const counts = { pages: page.number, read: page.read, staged, created: 0 };
  await tenantClient.signalRun.updateMany({ where: { id: runId }, data: { counts } });
  const newest = data.reduce(
    (max, { engagedAt }) => (engagedAt > max ? engagedAt : max),
    new Date(0),
  );
  return { reachedCut: read.reachedCut, newest: data.length > 0 ? newest.toISOString() : null };
}

/** The counts added to the run's, by name: the processing's drops and keeps. */
export async function addCounts(runId: string, added: Readonly<Record<string, number>>) {
  const row = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  if (row === null) return;
  const counts = { ...(row.counts as Record<string, number>) };
  for (const [name, count] of Object.entries(added)) {
    if (count > 0) counts[name] = (counts[name] ?? 0) + count;
  }
  await tenantClient.signalRun.updateMany({ where: { id: runId }, data: { counts } });
}

/**
 * The run's files deleted, outside any run, before its last step: its pages, its profiles' requests
 * and its profiles, so that no rejected candidate's profile outlives the run; the count.
 */
export async function deleteRunFiles(workspaceId: string, runId: string): Promise<number> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const { files: found } = await files.list({ workspaceId, prefix: runFolder(runId) });
  for (const { key } of found) await files.delete({ workspaceId, key });
  return found.length;
}

/**
 * The last step, whatever the end: the open block settled (the engagers read paid, the rest released),
 * the run's candidates deleted, the run ended with its code; a done run's newest candidate the
 * source's watermark; a failure on the account published as signals.source_blocked; the metric.
 */
export async function endRun(
  { workspaceId, sourceId, runId }: RunRef,
  end: RunEnd,
  usage: RunUsage,
  now = new Date(),
): Promise<void> {
  if (usage.usageId !== undefined) await settleCredits(usage.usageId, usage.read, usage.billed);
  await tenantClient.signalCandidate.deleteMany({ where: { runId } });
  const error = end.status === "failed" ? end.code : null;
  await tenantClient.signalRun.updateMany({
    where: { id: runId },
    data: { status: end.status, finishedAt: now, error },
  });
  if (end.status === "done" && end.newest !== undefined) {
    const watermark = { engagedAt: end.newest };
    await tenantClient.signalSource.updateMany({ where: { id: sourceId }, data: { watermark } });
  }
  if (error === linkedinPort.errors.linkedin_account_disconnected) {
    const blocked = { source_id: sourceId, run_id: runId };
    await publish(
      outboxWriter(tenantClient, workspaceId),
      events["signals.source_blocked"],
      blocked,
    );
  }
  signalsMetrics["signals.runs"].add(1, { outcome: end.status, code: error ?? "none" });
}

/** From `from` to `to`, or nothing when the run is in another state. */
async function setStatus(runId: string, from: "running" | "waiting", to: "running" | "waiting") {
  await tenantClient.signalRun.updateMany({
    where: { id: runId, status: from },
    data: { status: to },
  });
}
