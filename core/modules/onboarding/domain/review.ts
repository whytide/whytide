// The draft review (README "The drafter"): the accept and the discard of the pending draft, in the
// caller's tenant run, the record's row locked until it commits: of an accept and a save at once, the
// second waits for the first. Only a person's accept writes a drafted value into the record.
import { outboxWriter, Prisma, tenantClient } from "@whytide/db";
import { AppError, currentTenant, publish } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { type CompanyKnowledge, lockedRecordId, toRecord } from "./commands.ts";
import { applyDraft } from "./rules.ts";

/**
 * Accepts the pending draft (rules.ts applyDraft): the fields it let through are written and marked
 * `ai_draft`, the version moves by one and onboarding.company_knowledge_updated carries it, the draft
 * cleared, in one transaction; when no field changed, only the draft is cleared. Without a pending
 * draft, company_knowledge_no_draft.
 */
export async function acceptDraft(replaceEdited: boolean): Promise<CompanyKnowledge> {
  const { workspaceId } = currentTenant();
  const id = await lockedRecordId();
  const stored = toRecord(await tenantClient.companyKnowledge.findFirstOrThrow({ where: { id } }));
  if (stored.pendingDraft === null) throw new AppError(errors.company_knowledge_no_draft);
  const at = new Date().toISOString();
  const draft = stored.pendingDraft.fields;
  const { fields, fieldSources, changed } = applyDraft(stored, draft, { replaceEdited, at });
  if (changed.length === 0) return clearDraft(id);
  const version = stored.version + 1;
  const saved = await tenantClient.companyKnowledge.update({
    where: { id },
    data: {
      ...fields,
      proofPoints: fields.proofPoints as Prisma.InputJsonValue,
      fieldSources,
      version,
      pendingDraft: Prisma.DbNull,
    },
  });
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["onboarding.company_knowledge_updated"], { workspaceId, version });
  return toRecord(saved);
}

/** Discards the pending draft: the record keeps every field. Without one, company_knowledge_no_draft. */
export async function discardDraft(): Promise<CompanyKnowledge> {
  const id = await lockedRecordId();
  const { pendingDraft } = await tenantClient.companyKnowledge.findFirstOrThrow({
    where: { id },
    select: { pendingDraft: true },
  });
  if (pendingDraft === null) throw new AppError(errors.company_knowledge_no_draft);
  return clearDraft(id);
}

async function clearDraft(id: string): Promise<CompanyKnowledge> {
  const data = { pendingDraft: Prisma.DbNull };
  return toRecord(await tenantClient.companyKnowledge.update({ where: { id }, data }));
}
