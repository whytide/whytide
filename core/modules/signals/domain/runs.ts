// A source's runs as the worker drives them (README.md "Runs"; docs/flows.md): each function is one
// step of the run workflow's, called in an activity's own tenant run (context.tenant), on its
// transaction (tenantClient). The read quota and the credits are reserved and settled in steps of
// their own, never around the provider's read, which is linkedin's activity; a refusal is an answer
// the workflow waits on or ends with. The run's files are read, written and deleted outside any run.
// A posts kind's run stages its posts' authors and each post's engagers, its post in every row. A run
// started since gamma-p5-040 has a read budget, its share of its account's day (domain/schedule/),
// and reserves each read with SIGNALS_READS_KEPT_FOR_SENDS kept (settings.ts). A run's start names
// the agent its source is in (gamma-p5-045), whose audience the steps that filter read (agents.ts
// audienceOf).
import { json } from "node:stream/consumers";
import { outboxWriter, tenantClient } from "@whytide/db";
import {
  commitReads,
  findSenderAccount,
  errors as linkedinErrors,
  type PostsRequestFile,
  postsFile,
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
import {
  type Candidate,
  isKindReader,
  isPostsReader,
  isResearchReader,
  type PageCandidates,
} from "../sources/_contract.ts";
import { authorOf, engagersOf, stagedAt, unnamedPostUrl } from "../sources/_posts.ts";
import { ENGAGERS_PAGE_SIZE, ENGAGERS_READER } from "../sources/constants.ts";
import { sourceKind } from "../sources/registry.ts";
import { type AgentState, agentStateOf } from "./agents.ts";
import {
  BUDGET_REACHED,
  COMPANIES_PER_PRICE,
  companyCreditKeyOf,
  DAY_READING_ENDS,
  ENGAGERS_PER_READ,
  engagerCreditKeyOf,
  READ_BUDGET_REACHED,
} from "./constants.ts";
import { runFolder } from "./process/keys.ts";
import { UNENDED } from "./schedule/constants.ts";
import { budgetReachedIn, readBudgetOf } from "./schedule/daily.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Engagers per credit (prices.ts). */
const ENGAGERS_PER_BLOCK = 30;

/** A run as its steps name it: ids only. */
export type RunRef = {
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly runId: string;
  /**
   * The agent its start found the source in (gamma-p5-045), whose audience the steps that filter
   * read; none for a source in no agent, and in a run started before.
   */
  readonly playbookId?: string | undefined;
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
      /** Engaged before it is not new: the watermark, or the lookback's start; a posts kind's start. */
      readonly cutAt: string;
      /** A posts kind: its posts first, from `cutAt`, then each post's engagers (gamma-p5-020). */
      readonly posts?: true;
      /** The reads the run may make (gamma-p5-040), which a run before the patch never reads. */
      readonly readBudget: number;
      /** The agent the source is in now, read once here (gamma-p5-045); none for no agent. */
      readonly playbookId?: string;
    };
/** A budgeted run's budget and the reads it made, which each of its reservations checks. */
export type ReadBudget = { readonly readBudget: number; readonly used: number };
export type ReadReservation =
  | { readonly reservationId: string }
  | { readonly refused: string; readonly retryAt: string | null };
type Refused = { readonly refused: typeof creditsCodes.insufficient_credits };
/** A block of credits: with the blocks billed before it, it pays for the engagers read up to `until`. */
export type CreditsReservation = { readonly usageId: string; readonly until: number } | Refused;
/** A candidate's credit, reserved for its profile read (beta-p1-090). */
export type EngagerCredit = { readonly usageId: string } | Refused;
export type StagedPage = { readonly reachedCut: boolean; readonly newest: string | null };
/** A page of posts staged: each post's unnamed URL and its cut; whether their engagers are read. */
export type StagedPosts = {
  readonly posts: readonly { readonly postUrl: string; readonly cutAt: string }[];
  readonly engagers: boolean;
};
/** A posts kind's run's posts: each one's newest engagement staged, if any (the watermark). */
export type PostMarks = { readonly postUrl: string; readonly newest?: string | undefined }[];
export type RunEnd =
  | {
      readonly status: "done";
      readonly newest?: string | undefined;
      readonly posts?: PostMarks | undefined;
      /** Its budget, the cap or the 200 ended its reading: `counts.budget_reached`, the watermark kept. */
      readonly budgetReached?: boolean | undefined;
    }
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

/** The source a run started and its agent, as the first step leaves them (openRun). */
export type OpenedRun = {
  readonly source: NonNullable<Awaited<ReturnType<typeof tenantClient.signalSource.findFirst>>>;
  readonly agent: AgentState | null;
};

/**
 * What the first step of every run does (startRun; the research run's too, research.ts): the run's
 * row made (a scheduled run) or found as run now wrote it, with the id of the workflow that runs it,
 * `workflowId`, `running` from now, and the source's last_run_at now. A source gone starts nothing; a
 * run whose stop was asked before it started ends `cancelled` here and starts nothing either
 * (fix-run-stop), and so does a run of a source whose agent is paused, read before anything is
 * written (endBeforeStart, paused-agent-sources): `gone` for each.
 */
export async function openRun(
  ref: RunRef,
  workflowId: string,
  now: Date,
): Promise<{ readonly status: "gone" } | ({ readonly status: "opened" } & OpenedRun)> {
  const { workspaceId, sourceId, runId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return { status: "gone" };
  const agent = await agentStateOf(source.id);
  if (agent?.active === false) return endBeforeStart(runId, workflowId, now);
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
  return { status: "opened", source, agent };
}

/**
 * The first step: openRun, then, for a source that reads through a LinkedIn account, the account
 * connected or the run blocked, and the run's quota day and read budget (budgetOf), and the id of the
 * agent its source is in, whose audience its steps read: the id only, never the audience.
 */
export async function startRun(
  ref: RunRef,
  workflowId: string,
  now = new Date(),
): Promise<RunStart> {
  const { runId } = ref;
  const opened = await openRun(ref, workflowId, now);
  if (opened.status === "gone") return opened;
  const { source, agent } = opened;
  const kind = sourceKind(source.kind);
  const { reader } = kind;
  // The research kinds' run is signals_research_run's (workflows/), never this one's.
  if (isResearchReader(reader) || source.senderAccountId === null) {
    throw new Error("signals_run does not run a source that reads through no account");
  }
  const account = await findSenderAccount(source.senderAccountId).catch((error: unknown) => {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  });
  if (account?.status !== "connected") return { status: "blocked" };
  const readBudget = await budgetOf(runId, source.id, account.id);
  const inAgent = agent === null ? {} : { playbookId: agent.id };
  const quantity = blocksOf(settings.SIGNALS_ESTIMATED_PAGES * ENGAGERS_PAGE_SIZE);
  if (isPostsReader(reader)) {
    const cutAt = cutOf(null, kind.lookbackDays, now).toISOString();
    const engagers = { reader: ENGAGERS_READER, readerInput: {}, pageSize: ENGAGERS_PAGE_SIZE };
    const posts = { quantity, cutAt, posts: true as const, readBudget };
    return { status: "started", accountId: account.id, ...engagers, ...posts, ...inAgent };
  }
  return {
    status: "started",
    accountId: account.id,
    reader: reader.activity,
    readerInput: reader.input(source.config),
    pageSize: reader.pageSize,
    quantity: blocksOf(settings.SIGNALS_ESTIMATED_PAGES * reader.pageSize),
    cutAt: cutOf(source.watermark, kind.lookbackDays, now).toISOString(),
    readBudget,
    ...inAgent,
  };
}

/**
 * A run of a paused agent's source, ended before its start (paused-agent-sources): its row, written
 * before the pause (Run now's, a tick's) or left `running` by a failed attempt of this step, ends
 * `cancelled` with no read, as a stop before the start leaves one; a schedule's run, which has no
 * row yet, gets none. `gone`: the workflow ends here, with nothing reserved, read or charged.
 */
async function endBeforeStart(
  runId: string,
  workflowId: string,
  now: Date,
): Promise<{ readonly status: "gone" }> {
  const ended = await tenantClient.signalRun.updateMany({
    where: { id: runId, status: { in: [...UNENDED] } },
    data: { status: "cancelled", finishedAt: now, workflowId },
  });
  if (ended.count > 0)
    signalsMetrics["signals.runs"].add(1, { outcome: "cancelled", code: "none" });
  return { status: "gone" };
}

/**
 * The run's read budget: as its start's first attempt wrote it, with its quota day, else its share
 * of the account's day now (readBudgetOf), written to its row.
 */
async function budgetOf(runId: string, sourceId: string, accountId: string): Promise<number> {
  const row = await tenantClient.signalRun.findFirst({
    where: { id: runId },
    select: { readBudget: true },
  });
  if (row?.readBudget !== null && row?.readBudget !== undefined) return row.readBudget;
  const { quotaDay, readBudget } = await readBudgetOf(sourceId, accountId);
  await tenantClient.signalRun.updateMany({ where: { id: runId }, data: { quotaDay, readBudget } });
  return readBudget;
}

/**
 * The request file of the posts read's page `page` (linkedin's postsRequestFile): the kind's source,
 * the posts since `postedSince`, after the page before's file; null when the source is gone.
 */
export async function postsRequestOf(
  { sourceId }: RunRef,
  page: number,
  postedSince: string,
  after: string | undefined,
): Promise<PostsRequestFile | null> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  const reader = source === null ? null : sourceKind(source.kind).reader;
  if (reader === null || !isPostsReader(reader)) return null;
  const limit = reader.pageSize;
  return {
    source: reader.source(source?.config),
    postedSince,
    ...(page > 1 ? { after } : {}),
    limit,
  };
}

/**
 * One read reserved, a page's or a profile's, the run `running` again after a wait; refused for the
 * cap or the hours, the run `waiting` until `retryAt`; refused with `retryAt` null, the account is not
 * connected. A budgeted run (gamma-p5-040) reserves with SIGNALS_READS_KEPT_FOR_SENDS kept, and a
 * refusal that ends its day (DAY_READING_ENDS) leaves it `running`; once it made its budget's reads,
 * a slot the account grants goes back at once and the read is refused read_budget_reached. The
 * account's own refusals answer first, so a kill switch or a pause, which leave a budget of 0, still
 * end the run with their codes.
 */
export async function reserveRead(
  { runId }: RunRef,
  accountId: string,
  kind: "read_engagers" | "read_profile" | "read_posts" = "read_engagers",
  budget?: ReadBudget,
): Promise<ReadReservation> {
  const keep = budget === undefined ? {} : { keep: settings.SIGNALS_READS_KEPT_FOR_SENDS };
  const reserved = await reserveReads({ accountId, count: 1, kind, ...keep });
  if ("refused" in reserved) {
    const { refused, retryAt } = reserved;
    const endsDay = budget !== undefined && DAY_READING_ENDS.includes(refused);
    if (retryAt !== null && !endsDay) await setStatus(runId, "running", "waiting");
    return { refused, retryAt: retryAt?.toISOString() ?? null };
  }
  if (budget !== undefined && budget.used >= budget.readBudget) {
    await releaseReads(reserved.reservationId);
    return { refused: READ_BUDGET_REACHED, retryAt: null };
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

/**
 * A credit for a company a research run reads and judges (gamma-wr-051): one `signals.researched_company`,
 * keyed `sigco:<runId>:<candidateId>`, its subject the candidate, the 24-hour lease. A retried step finds
 * the key's row and charges once. Reserved before the company's site is read.
 */
export async function reserveCompanyCredit(
  { workspaceId, runId }: RunRef,
  candidateId: string,
): Promise<EngagerCredit> {
  return reserveOrRefuse({
    workspaceId,
    action: prices["signals.researched_company"],
    quantity: COMPANIES_PER_PRICE,
    idempotencyKey: companyCreditKeyOf(runId, candidateId),
    subjectRef: candidateId,
    lease: "async",
  });
}

/**
 * A company's credit settled: committed with its verdict, released when the site was not read, the model
 * could not answer or the run ended first. A release of a credit settled already is left alone.
 */
export async function settleCompanyCredit(usageId: string, judged: boolean): Promise<void> {
  if (judged) {
    await credits.commit(usageId);
    return;
  }
  try {
    await credits.release(usageId);
  } catch (error) {
    if (!isAppError(error) || error.code !== creditsCodes.usage_not_open) throw error;
  }
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

/** A file the reader wrote, read outside any run: the store is another process. */
export async function readPageFile(workspaceId: string, key: string): Promise<unknown> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return json((await files.get({ workspaceId, key })).body);
}

/** A request file written under the run's folder, outside any run. */
export async function writeRunFile(workspaceId: string, key: string, body: unknown): Promise<void> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  await files.put({
    workspaceId,
    key,
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}

/** The later of an ISO time, if any, and `floor`. */
const laterOf = (at: string | undefined, floor: Date): Date =>
  at !== undefined && Date.parse(at) > floor.getTime() ? new Date(at) : floor;

/** A posts kind's watermark, `{ posts: { <unnamed URL>: <newest engagedAt> } }`, read loosely. */
function marksOf(watermark: unknown): Record<string, string> {
  const posts = (watermark as { posts?: unknown } | null)?.posts;
  return typeof posts === "object" && posts !== null ? (posts as Record<string, string>) : {};
}

/**
 * The candidates staged, once per member, reaction and post in the run (an undated engager dated
 * at `floor`, never later than the listing), the run's counts as of the page merged: `pages`, `read`
 * (the engagers the provider answered), `staged`, and `created`, 0 until the processing adds to it.
 */
async function stage(
  { workspaceId, runId }: RunRef,
  kind: string,
  candidates: readonly Candidate[],
  rawRef: string,
  floor: Date,
  counts: (row: Record<string, number>) => Record<string, number>,
) {
  const data = candidates.map((one) => {
    const { commentText, dateKnown: _known, postExcerpt, ...candidate } = one;
    const engagedAt = stagedAt(one, floor);
    const id = newId(ids.signal_candidate);
    const words = { commentText: commentText ?? null, postExcerpt: postExcerpt ?? null };
    return { ...candidate, id, workspaceId, runId, ...words, engagedAt, rawRef };
  });
  const { count } = await tenantClient.signalCandidate.createMany({ data, skipDuplicates: true });
  signalsMetrics["signals.candidates"].add(count, { kind });
  const staged = await tenantClient.signalCandidate.count({ where: { runId } });
  const row = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  const merged = { ...counts((row?.counts ?? {}) as Record<string, number>), staged, created: 0 };
  await tenantClient.signalRun.updateMany({ where: { id: runId }, data: { counts: merged } });
  const newest = data.reduce(
    (max, { engagedAt }) => (engagedAt > max ? engagedAt : max),
    new Date(0),
  );
  return data.length > 0 ? newest.toISOString() : null;
}

/**
 * Where an undated engager is dated (gamma-p5-020): the later of its post's date, the source's save
 * for post engagers, and the start of the source's last done run, which read every post to its cut:
 * not one its budget ended (gamma-p5-040). Only a run started after the post or the save can count.
 */
async function floorOf(source: { id: string; createdAt: Date }, postedAt?: string) {
  const posted = postedAt === undefined ? source.createdAt : new Date(postedAt);
  const where = { sourceId: source.id, status: "done" as const, startedAt: { gt: posted } };
  const orderBy = { startedAt: "desc" as const };
  const select = { startedAt: true, counts: true };
  const done = await tenantClient.signalRun.findMany({ where, orderBy, select });
  const last = done.find((run) => !budgetReachedIn(run.counts));
  return laterOf(last?.startedAt?.toISOString(), posted);
}

/**
 * A page of engagers' candidates from the cut on staged, of the source's post or, for a posts kind,
 * of `post`, found in its posts file by its unnamed URL. A source gone ends the reading.
 */
export async function stagePage(
  ref: RunRef,
  page: {
    readonly number: number;
    readonly key: string;
    readonly cutAt: string;
    readonly read: number;
  },
  file: unknown,
  post?: { readonly postUrl: string; readonly file: unknown },
): Promise<StagedPage> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: ref.sourceId } });
  if (source === null) return { reachedCut: true, newest: null };
  const kind = sourceKind(source.kind);
  const { reader } = kind;
  const cut = new Date(page.cutAt);
  const url = post?.postUrl ?? "";
  const filed =
    post && postsFile.parse(post.file).posts.find((one) => unnamedPostUrl(one.postUrl) === url);
  let read: PageCandidates = { candidates: [], reachedCut: true };
  if (isKindReader(reader)) read = reader.page(file, source.config, cut);
  else if (isPostsReader(reader) && filed !== undefined) {
    const kept = reader.keepsReactions(source.config);
    read = engagersOf(file, { url, excerpt: filed.excerpt }, cut, kept);
  }
  const floor = await floorOf(source, filed?.postedAt);
  const counts = (row: Record<string, number>) => ({ ...row, pages: page.number, read: page.read });
  const newest = await stage(ref, kind.kind, read.candidates, page.key, floor, counts);
  return { reachedCut: read.reachedCut, newest };
}

/**
 * A page of a posts kind's posts staged: their authors from each post's cut on, when the kind keeps
 * them, and the counts `post_pages` and `posts`; each post's unnamed URL and its cut, its watermark
 * entry, else the lookback's start, `cutAt`. A source gone ends the reading.
 */
export async function stagePosts(
  ref: RunRef,
  page: { readonly number: number; readonly key: string; readonly cutAt: string },
  file: unknown,
): Promise<StagedPosts> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: ref.sourceId } });
  const kind = source === null ? null : sourceKind(source.kind);
  if (source === null || kind === null || !isPostsReader(kind.reader)) {
    return { posts: [], engagers: false };
  }
  const marks = marksOf(source.watermark);
  const posts = postsFile.parse(file).posts.flatMap((post) => {
    const url = unnamedPostUrl(post.postUrl);
    return url === null ? [] : [{ post, url, cut: laterOf(marks[url], new Date(page.cutAt)) }];
  });
  const authors = kind.reader.keepsAuthors(source.config)
    ? posts.flatMap(({ post, url, cut }) => {
        const author = authorOf(post, url);
        return author !== null && author.engagedAt >= cut ? [author] : [];
      })
    : [];
  const counts = (row: Record<string, number>) => {
    const read = { post_pages: page.number, posts: (row.posts ?? 0) + posts.length };
    return { ...row, ...read };
  };
  await stage(ref, kind.kind, authors, page.key, new Date(0), counts);
  const engagers = kind.reader.keepsReactions(source.config).length > 0;
  return {
    posts: posts.map(({ url, cut }) => ({ postUrl: url, cutAt: cut.toISOString() })),
    engagers,
  };
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
 * source's watermark, unless its budget ended its reading (`counts.budget_reached`, gamma-p5-040); a
 * failure on the account published as signals.source_blocked; the metric.
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
  // A run its budget ended keeps the watermark: the next day's run reads on from the same cut.
  if (end.status === "done" && end.budgetReached === true) await markBudgetReached(runId);
  else if (end.status === "done" && end.posts !== undefined) {
    // A posts kind's: each post read, within the lookback, its newest staged, else its old entry.
    const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
    const marks = marksOf(source?.watermark ?? null);
    const entries = end.posts.flatMap(({ postUrl, newest }) => {
      const at = newest ?? marks[postUrl];
      return at === undefined ? [] : [[postUrl, at] as const];
    });
    const watermark = { posts: Object.fromEntries(entries) };
    await tenantClient.signalSource.updateMany({ where: { id: sourceId }, data: { watermark } });
  } else if (end.status === "done" && end.newest !== undefined) {
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

/** The run's `budget_reached`, 1, set once: a retried last step sets the same. */
async function markBudgetReached(runId: string): Promise<void> {
  const row = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  if (row === null) return;
  const counts = { ...(row.counts as Record<string, number>), [BUDGET_REACHED]: 1 };
  await tenantClient.signalRun.updateMany({ where: { id: runId }, data: { counts } });
}

/** From `from` to `to`, or nothing when the run is in another state. */
async function setStatus(runId: string, from: "running" | "waiting", to: "running" | "waiting") {
  await tenantClient.signalRun.updateMany({
    where: { id: runId, status: from },
    data: { status: to },
  });
}
