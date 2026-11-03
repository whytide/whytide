// callAgent's reads and writes of decision_records (README.md "Decision records"), on the client of
// the tenant run it opens (core/packages/db README "The tenant transaction and the scoped client"),
// and, in the caller's run, the raw prompts' read and a subject's erasure.
import { type Prisma, type TenantClient, tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { aiErrors } from "../errors.ts";

/** What makes two calls one: the record of the key with status ok is the cached result. */
export type DecisionKey = {
  readonly workspaceId: string;
  readonly task: string;
  readonly subjectRef: string;
  readonly inputHash: string;
  readonly modelId: string;
  readonly promptVersion: number;
};

/** The key's record with status ok, the result cache; null when there is none. */
export function findDecision(
  tx: TenantClient,
  key: DecisionKey,
): Promise<Prisma.DecisionRecordModel | null> {
  return tx.decisionRecord.findFirst({ where: { ...key, status: "ok" } });
}

/**
 * Writes the call's record, one row per key: an ai_failed row, or the ok row `stale` whose output no
 * longer parses, is replaced, its id kept, by the next call of the key; any other ok row is never
 * changed, so a call that finds one written meanwhile by another call of the key returns that one.
 */
export async function saveDecision(
  tx: TenantClient,
  data: Prisma.DecisionRecordUncheckedCreateInput,
  stale?: string,
): Promise<Prisma.DecisionRecordModel> {
  const { workspaceId, task, subjectRef, inputHash, modelId, promptVersion } = data;
  const key = { workspaceId, task, subjectRef, inputHash, modelId, promptVersion };
  const existing = await tx.decisionRecord.findFirst({ where: key });
  if (existing?.status === "ok" && existing.id !== stale) return existing;
  if (existing) {
    return tx.decisionRecord.update({
      where: { id: existing.id },
      data: { ...data, id: existing.id },
    });
  }
  return tx.decisionRecord.create({ data });
}

/**
 * The raw prompt of each record named, in the caller's tenant run: the last attempt's user message,
 * null once the raw purge emptied it. A record past its raw_purge_after counts as purged, whether the
 * purge ran or not: it is not in the map, as a record of another workspace, or none, is not.
 */
export async function rawPrompts(ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await tenantClient.decisionRecord.findMany({
    where: { id: { in: [...ids] }, rawPurgeAfter: { gt: new Date() } },
    select: { id: true, rawPrompt: true },
  });
  return new Map(rows.map(({ id, rawPrompt }) => [id, rawPrompt]));
}

/**
 * Deletes the records whose subject_ref is the subject, in the caller's tenant run: a person's go with
 * the person (docs/rules/security.md §2), the deletion script's step (core/modules/privacy). The rows
 * deleted, by table. ai_input_invalid for an empty subject, which Prisma would drop from the where.
 */
export async function eraseDecisionRecords(
  subjectRef: string,
): Promise<{ decision_records: number }> {
  if (typeof subjectRef !== "string" || subjectRef.trim() === "") {
    throw new AppError(aiErrors.ai_input_invalid, { details: { fields: ["subjectRef"] } });
  }
  const { count } = await tenantClient.decisionRecord.deleteMany({ where: { subjectRef } });
  return { decision_records: count };
}
