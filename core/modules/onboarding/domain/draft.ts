// The Draft from website (README "The website fetch"): the route's command, which marks the record
// fetching under a new run and publishes onboarding.draft_requested in the same transaction, and the
// fetch activity's, which read the run's website and write its pages and status only while the run is
// still the record's latest; the drafter's (README "The drafter") read the pages and write the draft
// the same way, and a run of the prompt at sign-in accepts it there (README "The automatic accept").
// Each runs in the caller's tenant run, through tenantClient. A Draft's documents (README "The
// documents") are the record's, replaced by each Draft: the drafter reads them after the pages.
import { createHash } from "node:crypto";
import { outboxWriter, Prisma, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish, tenantErrors } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import type { PendingDraft } from "../schemas/draft-company-knowledge.ts";
import { settings } from "../settings.ts";
import { type CompanyKnowledge, lockedRecordId, toRecord } from "./commands.ts";
import {
  type DocumentRead,
  type DocumentStatus,
  type DraftDocument,
  documentSource,
} from "./documents.ts";
import type { FetchStatus } from "./fields.ts";
import { acceptDraft } from "./review.ts";
import { draftHasValue } from "./rules.ts";

/** What a Draft's workflow carries: the record and the run the Draft started. Ids only. */
export type DraftRun = {
  readonly workspaceId: string;
  readonly companyKnowledgeId: string;
  readonly draftRunId: string;
};
/** truncated: the page past one megabyte, or its text past 50,000 characters, was cut. */
export type PageStatus = "fetched" | "truncated";
/** A page the fetch read; its address after redirects and its time are its provenance. */
export type FetchedPage = {
  readonly url: string;
  readonly status: PageStatus;
  readonly fetchedAt: Date;
  readonly title: string;
  readonly text: string;
  readonly contentHash: string;
};
/** What a fetch ended with: its pages, the home page first, or the machine code it failed with. */
export type FetchOutcome =
  | { readonly ok: true; readonly pages: readonly FetchedPage[] }
  | { readonly ok: false; readonly code: string };
/** What a run wrote, kept in Temporal's history: a count and a code, never an address or a text. */
export type FetchResult = {
  readonly status: "fetched" | "failed" | "superseded";
  readonly pages: number;
  readonly code?: string;
};
/** A page as the routes answer it. */
export type WebsitePage = {
  readonly url: string;
  readonly title: string;
  readonly status: PageStatus;
  readonly fetchedAt: Date;
};
/** A page as the drafter reads it: its address, its title and its text, nothing else. */
export type DraftPage = { readonly url: string; readonly title: string; readonly text: string };
/** What the drafter ended with: the draft, or the machine code it failed with. */
export type DraftOutcome =
  | { readonly ok: true; readonly draft: PendingDraft }
  | { readonly ok: false; readonly code: string };
/** What a Draft's run ended with, kept in Temporal's history: a count and a code. */
export type RunResult = {
  readonly status: "drafted" | "failed" | "superseded";
  readonly pages: number;
  readonly code?: string;
};
/** Where the record's latest Draft stands: its run, its status and code, its pending draft. */
export type DraftState = {
  readonly companyKnowledgeId: string;
  readonly draftRunId: string | null;
  readonly fetchStatus: FetchStatus;
  readonly fetchError: string | null;
  readonly pendingDraft: PendingDraft | null;
};

/**
 * Starts a Draft: the record becomes `fetching` under a new run, its error and draft cleared, its
 * documents replaced by `documents`, and onboarding.draft_requested carries the ids to the worker, in
 * the same transaction. More documents than ONBOARDING_MAX_FILES is documents_too_many, before
 * anything is read or written. With `autoAccept` the run accepts its own draft as it lands
 * (recordDraft).
 * A record without a website drafts from its documents alone; with neither, it is
 * company_knowledge_no_website. A Draft while one is fetching starts a new run: the older one can no
 * longer write.
 */
export async function requestDraft(
  workspaceId: string,
  documents: readonly DraftDocument[] = [],
  options: { readonly autoAccept?: boolean } = {},
): Promise<CompanyKnowledge> {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
  const files = settings.ONBOARDING_MAX_FILES;
  if (documents.length > files)
    throw new AppError(errors.documents_too_many, { details: { files } });
  const id = await lockedRecordId();
  const { sourceUrl } = await tenantClient.companyKnowledge.findFirstOrThrow({
    where: { id },
    select: { sourceUrl: true },
  });
  if (sourceUrl === null && documents.length === 0) {
    throw new AppError(errors.company_knowledge_no_website);
  }
  const draftRunId = newId(ids.draft_run);
  const draftAutoAccept = options.autoAccept ?? false;
  const row = await tenantClient.companyKnowledge.update({
    where: { id },
    data: {
      ...{ fetchStatus: "fetching", fetchError: null, draftRunId, draftAutoAccept },
      pendingDraft: Prisma.DbNull,
    },
  });
  await tenantClient.companyDocument.deleteMany({ where: { companyKnowledgeId: id } });
  // Made in the order given, the ids sort in it: draftDocuments reads by them.
  const addedAt = new Date();
  const data = documents.map(({ name, mediaType, status, text }) => ({
    ...{ id: newId(ids.company_document), workspaceId, companyKnowledgeId: id },
    ...{ name, mediaType, status, text, addedAt },
    contentHash: createHash("sha256").update(text).digest("hex"),
  }));
  await tenantClient.companyDocument.createMany({ data });
  const payload = { workspaceId, companyKnowledgeId: id, draftRunId };
  await publish(
    outboxWriter(tenantClient, workspaceId),
    events["onboarding.draft_requested"],
    payload,
  );
  return toRecord(row);
}

/**
 * The website `run` fetches while it is the record's latest Draft, `website` null when the record has
 * none (a Draft from documents alone); null once a later Draft started.
 */
export async function draftWebsite(
  run: DraftRun,
): Promise<{ readonly website: string | null } | null> {
  const row = await tenantClient.companyKnowledge.findFirst({
    where: { id: run.companyKnowledgeId },
    select: { sourceUrl: true, draftRunId: true },
  });
  return row?.draftRunId === run.draftRunId ? { website: row.sourceUrl } : null;
}

/**
 * Writes what the fetch of `run` ended with, only while `run` is still the record's latest Draft:
 * the compare and the writes in one transaction, the record's row locked. The pages replace the last
 * run's and the record becomes `fetched`; a failure removes them and keeps its code. `fetchedAt` is
 * when the run ended, either way.
 */
export async function recordFetch(run: DraftRun, outcome: FetchOutcome): Promise<FetchResult> {
  if ((await latestRun(run)) === null) return { status: "superseded", pages: 0 };
  const id = run.companyKnowledgeId;
  const { workspaceId } = currentTenant();
  const fetchedAt = new Date();
  await tenantClient.websitePage.deleteMany({ where: { companyKnowledgeId: id } });
  if (!outcome.ok) {
    await tenantClient.companyKnowledge.update({
      where: { id },
      data: { fetchStatus: "failed", fetchError: outcome.code, fetchedAt },
    });
    return { status: "failed", pages: 0, code: outcome.code };
  }
  // Made in the order read, the ids sort in it: listWebsitePages reads by them.
  const data = outcome.pages.map((page) => ({
    ...page,
    id: newId(ids.website_page),
    workspaceId,
    companyKnowledgeId: id,
  }));
  await tenantClient.websitePage.createMany({ data });
  await tenantClient.companyKnowledge.update({
    where: { id },
    data: { fetchStatus: "fetched", fetchError: null, fetchedAt },
  });
  return { status: "fetched", pages: data.length };
}

/** The pages the fetch of `run` read, in the order read, while `run` is the record's latest Draft. */
export async function draftPages(run: DraftRun): Promise<DraftPage[] | null> {
  const row = await tenantClient.companyKnowledge.findFirst({
    where: { id: run.companyKnowledgeId },
    select: { draftRunId: true },
  });
  if (row?.draftRunId !== run.draftRunId) return null;
  return tenantClient.websitePage.findMany({
    where: { companyKnowledgeId: run.companyKnowledgeId },
    orderBy: { id: "asc" },
    select: { url: true, title: true, text: true },
  });
}

/**
 * The documents of the record's latest Draft as the drafter reads them, after the pages, in the order
 * given: each one's source `document:<name>` as its address, its name as its title, and its text.
 * The drafter reads them in the run where draftPages found the run still the latest.
 */
export async function draftDocuments(companyKnowledgeId: string): Promise<DraftPage[]> {
  const rows = await tenantClient.companyDocument.findMany({
    where: { companyKnowledgeId },
    orderBy: { id: "asc" },
    select: { name: true, text: true },
  });
  return rows.map(({ name, text }) => ({ url: documentSource(name), title: name, text }));
}

/** The documents of the record's latest Draft, by name and status, in the order given. */
export async function listCompanyDocuments(companyKnowledgeId: string): Promise<DocumentRead[]> {
  const rows = await tenantClient.companyDocument.findMany({
    where: { companyKnowledgeId },
    orderBy: { id: "asc" },
    select: { name: true, status: true },
  });
  return rows.map((row) => ({ ...row, status: row.status as DocumentStatus }));
}

/** Where the run's record's latest Draft stands: what the script reads while it waits. */
export async function draftState(): Promise<DraftState> {
  const row = await tenantClient.companyKnowledge.findFirstOrThrow({
    select: {
      id: true,
      draftRunId: true,
      fetchStatus: true,
      fetchError: true,
      pendingDraft: true,
    },
  });
  return {
    companyKnowledgeId: row.id,
    draftRunId: row.draftRunId,
    fetchStatus: row.fetchStatus as FetchStatus,
    fetchError: row.fetchError,
    pendingDraft: row.pendingDraft as PendingDraft | null,
  };
}

/**
 * Writes what the drafter of `run` ended with while `run` is the record's latest Draft, the row
 * locked: the pending draft and `drafted`, or `failed` with the code. Only an accept writes a field:
 * a run with the automatic accept accepts its draft here, in the same transaction, as Accept does
 * without replacing the fields a person wrote (review.ts acceptDraft); its draft with no value saves
 * nothing and fails with draft_empty.
 */
export async function recordDraft(
  run: DraftRun,
  outcome: DraftOutcome,
  pages: number,
): Promise<RunResult> {
  const latest = await latestRun(run);
  if (latest === null) return { status: "superseded", pages: 0 };
  const where = { id: run.companyKnowledgeId };
  const failed = async (code: string): Promise<RunResult> => {
    const data = { fetchStatus: "failed", fetchError: code, pendingDraft: Prisma.DbNull };
    await tenantClient.companyKnowledge.update({ where, data });
    return { status: "failed", pages, code };
  };
  if (!outcome.ok) return failed(outcome.code);
  if (latest.autoAccept && !draftHasValue(outcome.draft.fields)) return failed("draft_empty");
  const data = { fetchStatus: "drafted", fetchError: null, pendingDraft: outcome.draft };
  await tenantClient.companyKnowledge.update({ where, data });
  if (latest.autoAccept) await acceptDraft(false);
  return { status: "drafted", pages };
}

/**
 * Locks the record's row until the run commits; while `run` is still its latest Draft, whether that
 * run accepts its own draft; else null.
 */
async function latestRun(run: DraftRun): Promise<{ readonly autoAccept: boolean } | null> {
  const id = await lockedRecordId();
  const row = await tenantClient.companyKnowledge.findFirstOrThrow({
    where: { id },
    select: { draftRunId: true, draftAutoAccept: true },
  });
  const latest = id === run.companyKnowledgeId && row.draftRunId === run.draftRunId;
  return latest ? { autoAccept: row.draftAutoAccept } : null;
}

/** The pages the last fetch read, in the order it read them. */
export async function listWebsitePages(companyKnowledgeId: string): Promise<WebsitePage[]> {
  const rows = await tenantClient.websitePage.findMany({
    where: { companyKnowledgeId },
    orderBy: { id: "asc" },
    select: { url: true, title: true, status: true, fetchedAt: true },
  });
  return rows.map((row) => ({ ...row, status: row.status as PageStatus }));
}
