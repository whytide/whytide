// A person's signal events and their evidence (README.md "API", "Erasure"), in the caller's tenant
// run: the lead page's read (alpha-p8-050), and the person's erasure, which the deletion script calls
// before contacts' own (alpha-p10-030).
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";

/**
 * The person's events, newest first, each with its evidence or null; person_not_found (contacts').
 * Two reads: the tenant guard refuses a relation in a query's arguments.
 */
export async function listEvidence(personId: string) {
  const person = await getPerson(personId);
  const events = await tenantClient.signalEvent.findMany({
    where: { personId: person.id },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  const rows = await tenantClient.evidence.findMany({
    where: { eventId: { in: events.map(({ id }) => id) } },
  });
  const byEvent = new Map(rows.map((row) => [row.eventId, row]));
  return events.map((event) => ({ ...event, evidence: byEvent.get(event.id) ?? null }));
}
export type SignalEvent = Awaited<ReturnType<typeof listEvidence>>[number];

/**
 * Deletes the person's events and their evidence, the evidence first (the key's ON DELETE CASCADE
 * would take it too, uncounted), whether contacts still has the person or not; person_not_found for
 * an id that names nobody. The rows deleted, by table.
 */
export async function erasePerson(
  personId: string,
): Promise<Readonly<Record<"signal_events" | "evidence", number>>> {
  // Prisma drops an undefined value from a where: unchecked, that would be every event.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const events = await tenantClient.signalEvent.findMany({
    where: { personId },
    select: { id: true },
  });
  const eventId = { in: events.map((event) => event.id) };
  const evidence = await tenantClient.evidence.deleteMany({ where: { eventId } });
  const deleted = await tenantClient.signalEvent.deleteMany({ where: { personId } });
  return { signal_events: deleted.count, evidence: evidence.count };
}
