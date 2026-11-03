// onboarding's commands and its public reads (README "Commands"), in the caller's tenant run: they
// read and write through tenantClient, the run's transaction scoped to its workspace (core/packages/db
// README "The tenant transaction and the scoped client"), and open no run of their own. The api's
// handlers call them in the request's run; the drafter and the writer, later, in their own.
import { outboxWriter, type Prisma, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish, tenantErrors } from "@whytide/platform";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import type { PendingDraft } from "../schemas/draft-company-knowledge.ts";
import type { CompanyKnowledgeFields, FetchStatus, FieldSources, ProofPoint } from "./fields.ts";
import { changedFields, domainOf, markFields, normalize } from "./rules.ts";

/** The workspace's one Company Knowledge record. */
export type CompanyKnowledge = CompanyKnowledgeFields & {
  readonly id: string;
  readonly fetchStatus: FetchStatus;
  readonly fetchedAt: Date | null;
  /** The machine code of the last failed fetch (alpha-p4-020). */
  readonly fetchError: string | null;
  /** Who wrote each content field last; a field nobody wrote has none. */
  readonly fieldSources: FieldSources;
  /** 1 when created; one more with every save that changes a field. */
  readonly version: number;
  readonly updatedAt: Date;
  /** The drafter's draft, until accepted or discarded (alpha-p4-030). */
  readonly pendingDraft: PendingDraft | null;
};

type Row = Prisma.CompanyKnowledgeGetPayload<object>;

/** The workspace's record; the first read creates it empty, with `fetchStatus` none. */
export async function getCompanyKnowledge(workspaceId: string): Promise<CompanyKnowledge> {
  if (currentTenant().workspaceId !== workspaceId) throw new AppError(tenantErrors.tenant_mismatch);
  return toRecord(await ensureRecord());
}

/**
 * The public read the drafter and the writer call, in their own tenant run: the record as GET
 * answers it, created empty on the first read; another workspace than the run's is tenant_mismatch.
 */
export const readCompanyKnowledge: (workspaceId: string) => Promise<CompanyKnowledge> =
  getCompanyKnowledge;

/** The run's company domain, the host of `sourceUrl` without `www.` (the own-employee filter); null without a website. */
export async function getCompanyDomain(): Promise<string | null> {
  const row = await tenantClient.companyKnowledge.findFirst({ select: { sourceUrl: true } });
  return domainOf(row?.sourceUrl ?? null);
}

/**
 * Saves the website and every content field. Each content field that changed is marked `human`;
 * any change moves the version by one and publishes onboarding.company_knowledge_updated with it, in
 * the same transaction. A save that changes nothing writes nothing; an invalid URL writes nothing.
 */
export async function saveCompanyKnowledge(
  fields: CompanyKnowledgeFields,
): Promise<CompanyKnowledge> {
  const next = normalize(fields);
  const { workspaceId } = currentTenant();
  const id = await lockedRecordId();
  const stored = toRecord(await tenantClient.companyKnowledge.findFirstOrThrow({ where: { id } }));
  const changed = changedFields(stored, next);
  if (changed.length === 0 && stored.sourceUrl === next.sourceUrl) return stored;
  const mark = { kind: "human", at: new Date().toISOString() } as const;
  const fieldSources = markFields(stored.fieldSources, changed, mark);
  const version = stored.version + 1;
  const saved = await tenantClient.companyKnowledge.update({
    where: { id },
    data: {
      ...next,
      proofPoints: next.proofPoints as Prisma.InputJsonValue,
      fieldSources,
      version,
    },
  });
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["onboarding.company_knowledge_updated"], { workspaceId, version });
  return toRecord(saved);
}

/**
 * The run's record, created when there is none. Two first reads at once: the second insert waits for
 * the first one's commit and skips it (ON CONFLICT DO NOTHING), then reads that row.
 */
async function ensureRecord(): Promise<Row> {
  const found = await tenantClient.companyKnowledge.findFirst({});
  if (found !== null) return found;
  const { workspaceId } = currentTenant();
  const data = [{ id: newId(ids.company_knowledge), workspaceId }];
  await tenantClient.companyKnowledge.createMany({ data, skipDuplicates: true });
  return tenantClient.companyKnowledge.findFirstOrThrow({});
}

/**
 * The run's record's id, its row locked until the run commits: of two saves at once, the second
 * waits for the first and compares with what it committed, so no version is given twice.
 */
export async function lockedRecordId(): Promise<string> {
  const { id } = await ensureRecord();
  const { workspaceId } = currentTenant();
  await tenantClient.$queryRaw`
    SELECT id FROM company_knowledge WHERE id = ${id} AND workspace_id = ${workspaceId} FOR UPDATE`;
  return id;
}

/** A row as the record, its JSON columns typed: the commands are their only writer. */
export function toRecord(row: Row): CompanyKnowledge {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    fetchStatus: row.fetchStatus as FetchStatus,
    fetchedAt: row.fetchedAt,
    fetchError: row.fetchError,
    oneLiner: row.oneLiner,
    longDescription: row.longDescription,
    products: row.products,
    painPoints: row.painPoints,
    featuresBenefits: row.featuresBenefits,
    proofPoints: row.proofPoints as ProofPoint[],
    competitors: row.competitors,
    tone: row.tone,
    fieldSources: row.fieldSources as FieldSources,
    version: row.version,
    updatedAt: row.updatedAt,
    pendingDraft: row.pendingDraft as PendingDraft | null,
  };
}
