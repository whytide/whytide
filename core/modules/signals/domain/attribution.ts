// Where a lead came from, for the lead page's evidence panel (README.md "API", alpha-p8-050), in the
// caller's tenant run: contacts' sources of the lead, the first and the others, each signal source
// named by its label, an import by its file (the entry's own label, none before csv-import-sources),
// and the labels of the sources the person's events name.
import { getLead, type LeadSource } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { isAppError } from "@whytide/platform";

export type NamedSource = { kind: LeadSource["kind"]; label: string | null };
export type Attribution = { first: NamedSource; others: NamedSource[] };

/**
 * The lead's attribution, null for a person without a lead, and the label of every signal source it
 * or `sourceIds` name (a deleted source has none): one read of the sources.
 */
export async function attributionOf(personId: string, sourceIds: readonly (string | null)[]) {
  const lead = await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === "lead_not_found") return null;
    throw error;
  });
  const sources = lead?.sources ?? [];
  const refs = sources.flatMap(({ kind, ref }) => (kind === "signal" ? [ref] : []));
  const ids = [...new Set([...refs, ...sourceIds])].filter((id): id is string => id !== null);
  const rows = await tenantClient.signalSource.findMany({
    where: { id: { in: ids } },
    select: { id: true, label: true },
  });
  const labels = new Map(rows.map(({ id, label }) => [id, label]));
  const named = ({ kind, ref, label }: LeadSource): NamedSource => ({
    kind,
    label: kind === "signal" ? (labels.get(ref) ?? null) : (label ?? null),
  });
  const [first, ...others] = sources.map(named);
  const attribution: Attribution | null = first ? { first, others } : null;
  return { attribution, labels };
}
