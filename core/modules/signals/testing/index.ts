// signals' test factories (README.md "Testing"), `@whytide/signals/testing`, for tests only: a source,
// a run, and a person's event with its evidence, written on asRole("app") of @whytide/db/testing, so
// the test file calls withTestDb() first, or on the client given (the web's e2e api seeds the runs
// and the evidence of its database so). useSignalsClient points the create's own run at the test's
// client, and shortLinks.get, which a test replaces with mock.method, is a short link's request.
import type { Prisma, PrismaClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import type { SignalEvent } from "../domain/evidence.ts";
import type { SignalRun, SignalRunStatus, SignalSource } from "../domain/sources.ts";
import { eventIdOf, ids } from "../ids.ts";

export { useClient as useSignalsClient } from "../domain/client.ts";
export { useLookupAtFind } from "../domain/research/lookup-at-find.ts";
export { forgetReads, useReadPage } from "../domain/research/read-page.ts";
export { shortLinks } from "../sources/post_engagers/post-url.ts";
export { textPdf } from "./pdf.ts";

const POST_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000009";

/**
 * An enabled post_engagers source with the label, on its post or `postUrl`, its sender account named
 * by an id alone. With `kind`, `config`, `senderAccountId` (null for a source with none) or
 * `createdBy`, a source of another kind, as a web_research one (gamma-wr-030), written straight to the
 * table.
 */
export function createSignalSource(
  input: {
    workspaceId: string;
    label: string;
    postUrl?: string;
    kind?: string;
    config?: Record<string, unknown>;
    senderAccountId?: string | null;
    createdBy?: string;
  },
  client: PrismaClient = asRole("app"),
): Promise<SignalSource> {
  const { workspaceId, label, postUrl = POST_URL } = input;
  const { kind = "post_engagers", config = { postUrl } } = input;
  const { senderAccountId = "sac_test", createdBy = "usr_test" } = input;
  return client.signalSource.create({
    data: {
      id: newId(ids.signal_source),
      ...{ workspaceId, kind, config: config as Prisma.InputJsonValue, label },
      ...{ senderAccountId, createdBy },
    },
  });
}

/** A run of the source, `scheduled` and never started unless the input says otherwise. */
export function createSignalRun(
  input: {
    workspaceId: string;
    sourceId: string;
    status?: SignalRunStatus;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    counts?: Record<string, number>;
    error?: string | null;
  },
  client: PrismaClient = asRole("app"),
): Promise<SignalRun> {
  const {
    status = "scheduled",
    startedAt = null,
    finishedAt = null,
    counts = {},
    error = null,
  } = input;
  const { workspaceId, sourceId } = input;
  return client.signalRun.create({
    data: {
      id: newId(ids.signal_run),
      workspaceId,
      sourceId,
      status,
      startedAt,
      finishedAt,
      counts,
      error,
    },
  });
}

/**
 * A research run's plan with its queries in order (gamma-wr-040), written straight to the tables: the
 * words, source types and queries given, or one of each by default; a query is asked, with its results,
 * when it has `askedAt`.
 */
export async function createResearchPlan(
  input: {
    workspaceId: string;
    sourceId: string;
    runId: string;
    words?: { language: string; words: string[] }[];
    /** gamma-wr-090: the audience's role words by language; none by default, as a plan of an earlier version. */
    roleWords?: { language: string; words: string[] }[];
    placeIds?: string[];
    queries?: { text: string; placeId?: string; askedAt?: Date; resultCount?: number }[];
  },
  client: PrismaClient = asRole("app"),
) {
  const { workspaceId, sourceId, runId } = input;
  const { words = [{ language: "pl", words: ["alpha"] }], placeIds = ["web_search"] } = input;
  const { queries = [{ text: "first query" }] } = input;
  const plan = await client.signalResearchPlan.create({
    data: {
      ...{ id: newId(ids.signal_research_plan), workspaceId, sourceId, runId, words, placeIds },
      ...(input.roleWords === undefined ? {} : { roleWords: input.roleWords }),
    },
  });
  await client.signalResearchQuery.createMany({
    data: queries.map(({ text, placeId = "web_search", askedAt, resultCount }, at) => ({
      ...{ id: newId(ids.signal_research_query), workspaceId, planId: plan.id, sourceId },
      ...{ position: at + 1, placeId, country: "PL", language: "pl", text },
      ...{ askedAt: askedAt ?? null, resultCount: resultCount ?? null },
    })),
  });
  return plan;
}

/**
 * A research candidate (gamma-wr-046) of the source at `domain`, pending unless `state` says
 * otherwise, found by `runId` (a made-up one by default), written straight to the table; `stateAt` is
 * now unless given.
 */
export async function createResearchCandidate(
  input: {
    workspaceId: string;
    sourceId: string;
    domain: string;
    name?: string;
    runId?: string;
    state?: "pending" | "read" | "dropped";
    dropCode?: string;
    stateAt?: Date;
    createdAt?: Date;
  },
  client: PrismaClient = asRole("app"),
): Promise<{ id: string; workspaceId: string; sourceId: string; domain: string }> {
  const { workspaceId, sourceId, domain, state = "pending", dropCode, stateAt, createdAt } = input;
  return client.signalResearchCandidate.create({
    data: {
      ...{ id: newId(ids.signal_research_candidate), workspaceId, sourceId, domain, state },
      ...{ name: input.name ?? domain, runId: input.runId ?? "run_made_up" },
      ...{ pageUrl: `https://${domain}/`, dropCode: dropCode ?? null },
      ...(stateAt === undefined ? {} : { stateAt }),
      ...(createdAt === undefined ? {} : { createdAt }),
    },
  });
}

/**
 * A found company (gamma-wr-050) of the source at `domain`, judged `fit` unless `verdict` says
 * otherwise, written straight to the table with the source's label.
 */
export async function createFoundCompany(
  input: {
    workspaceId: string;
    sourceId: string;
    domain: string;
    sourceLabel?: string;
    name?: string;
    verdict?: "fit" | "not_fit" | "unsure";
    judgedAt?: Date;
    /** gamma-wr-060: the run that judged it, and its company in contacts. */
    runId?: string;
    companyId?: string;
    /** gamma-wr-110: the reasons, where it is and how it is reached, the page that led to it, and a member's mark. */
    reasons?: object[];
    country?: string;
    town?: string;
    state?: string;
    placeId?: string;
    pageUrl?: string;
    email?: string;
    phones?: string[];
    postalAddress?: string;
    memberMark?: { by: string; at?: Date };
  },
  client: PrismaClient = asRole("app"),
): Promise<{ id: string; workspaceId: string; sourceId: string | null; domain: string }> {
  const { workspaceId, sourceId, domain, verdict = "fit", judgedAt, memberMark } = input;
  const { runId = "run_made_up", companyId } = input;
  const optional = {
    ...{ country: input.country, town: input.town, state: input.state, placeId: input.placeId },
    ...{ email: input.email, phones: input.phones, postalAddress: input.postalAddress },
    ...{ companyId },
  };
  return client.signalFoundCompany.create({
    data: {
      ...{ id: newId(ids.signal_found_company), workspaceId, sourceId, domain, verdict },
      ...{ name: input.name ?? domain, sourceLabel: input.sourceLabel ?? "a source" },
      ...{ runId, reasons: input.reasons ?? [] },
      ...{ pageUrl: input.pageUrl ?? `https://${domain}/` },
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      ...(judgedAt === undefined ? {} : { judgedAt }),
      ...(memberMark === undefined
        ? {}
        : {
            ...{ memberMark: "not_fit", memberMarkedBy: memberMark.by },
            memberMarkedAt: memberMark.at ?? new Date(),
          }),
    },
  });
}

/**
 * The person's engagement with a post, its post or `url`, with its evidence and `postExcerpt`, if any:
 * a like, or a comment with `commentText`, unless `reaction` says otherwise; no source unless
 * `sourceId` names one, no run unless `runId` does; `occurredAt` now unless given. With `reducedAt`,
 * reduced as alpha-p10-020 leaves it: no excerpt or comment. With `candidateId`, the event a run's
 * processing makes of that candidate since beta-p1-090, whose id carries the candidate's ULID; else
 * one made before. `kind` is post_engagement unless given; an author's `ownWords` are its excerpt;
 * with `rating`, the event is rated (gamma-p5-030).
 */
export async function createSignalEvent(
  input: {
    workspaceId: string;
    personId: string;
    occurredAt?: Date;
    commentText?: string;
    reaction?: "like" | "comment" | "repost" | "author";
    sourceId?: string;
    runId?: string;
    author?: string;
    reducedAt?: Date;
    candidateId?: string;
    url?: string;
    postExcerpt?: string;
    kind?: string;
    ownWords?: string;
    rating?: { relevance: number; intentClass: string | null; rationale?: string };
    /**
     * A Web research event (gamma-wr-061): of this found company, kind `web_research`, its evidence the
     * page `url` with no reaction, author or words, as gamma-wr-060 writes it.
     */
    research?: { foundCompanyId: string; foundBy?: string };
  },
  client: PrismaClient = asRole("app"),
): Promise<SignalEvent> {
  const { workspaceId, personId, occurredAt = new Date(), sourceId = null, runId = null } = input;
  const { author = "Test Engager", reducedAt = null, url = POST_URL, postExcerpt = null } = input;
  const commentText = reducedAt === null ? (input.commentText ?? null) : null;
  const reaction = input.reaction ?? (input.commentText === undefined ? "like" : "comment");
  const { candidateId } = input;
  const id = candidateId === undefined ? newId(ids.signal_event) : eventIdOf(candidateId);
  const dedupeKey = `test:${id}`;
  const { research, rating } = input;
  const kind = research === undefined ? (input.kind ?? "post_engagement") : "web_research";
  const rated = rating && {
    ...{ relevance: rating.relevance, intentClass: rating.intentClass },
    ...{ relevanceRationale: rating.rationale ?? null, ratingStatus: "rated" as const },
  };
  const event = await client.signalEvent.create({
    data: {
      ...{ id, workspaceId, personId, sourceId, runId, kind, dedupeKey, occurredAt, ...rated },
      ...(research === undefined ? {} : { foundCompanyId: research.foundCompanyId }),
    },
  });
  const evidence = await client.evidence.create({
    data: {
      id: newId(ids.evidence),
      workspaceId,
      eventId: id,
      url,
      excerpt: reducedAt === null ? (input.ownWords ?? commentText) : null,
      postExcerpt,
      commentText,
      reaction: research === undefined ? reaction : null,
      author: research === undefined ? author : null,
      capturedAt: occurredAt,
      reducedAt,
      foundBy: research?.foundBy ?? null,
    },
  });
  return { ...event, evidence };
}
