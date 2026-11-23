// A person's signal events and their evidence (README.md "API", "Erasure"), in the caller's tenant
// run: the lead page's read (alpha-p8-050), and the person's erasure, which the deletion script calls
// before contacts' own (alpha-p10-030), with the scrub of where signals names them (gamma-p5-020).
import { eraseDecisionRecords, eraseDecisionRecordsById } from "@whytide/ai";
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, isAppError } from "@whytide/platform";
import { decodedLower, namesAuthor, unnamedPostUrl } from "../sources/_posts.ts";
import { NAMED_POSTS } from "../sources/constants.ts";
import { registeredSourceKinds } from "../sources/registry.ts";
import { ENDED } from "./constants.ts";
import { stopRun, updateSource } from "./sources.ts";

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
 * would take it too, uncounted), whether contacts still has the person or not, and the decision
 * records their ratings name: a rating batch's subject is its source, so ai's erasure by person
 * misses it; the batch's other events keep its id, pointing nowhere (no key holds it). Then every
 * triage record of the workspace, its subject (signals-triage-ai): their raw prompts hold the
 * headlines of every batch, and no row says which batches held the person's.
 * person_not_found for an id that names nobody. Then the scrub, by their public id from contacts'
 * person (erased after signals; gone, nothing is scrubbed): each source whose kind's `scrub` finds
 * them in its config is disabled, its runs not ended stopped as Stop stops them, its URL and label
 * emptied; other people's evidence whose /posts/ URL names them as its author gets the post's
 * unnamed URL and loses `post_excerpt`, its event, reaction and dates kept. The rows deleted, by
 * table.
 */
export async function erasePerson(
  personId: string,
): Promise<Readonly<Record<"signal_events" | "evidence" | "decision_records", number>>> {
  // Prisma drops an undefined value from a where: unchecked, that would be every event.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const events = await tenantClient.signalEvent.findMany({
    where: { personId },
    select: { id: true, decisionRecordId: true },
  });
  const eventId = { in: events.map((event) => event.id) };
  const evidence = await tenantClient.evidence.deleteMany({ where: { eventId } });
  const deleted = await tenantClient.signalEvent.deleteMany({ where: { personId } });
  const named = new Set(events.flatMap(({ decisionRecordId }) => decisionRecordId ?? []));
  const rated = await eraseDecisionRecordsById([...named]);
  const triaged = await eraseDecisionRecords(currentTenant().workspaceId);
  const slug = await publicIdOf(personId);
  if (slug !== null) await scrub(slug);
  const decision_records = rated.decision_records + triaged.decision_records;
  return { signal_events: deleted.count, evidence: evidence.count, decision_records };
}

/** The public id of contacts' person, the slug of its LinkedIn URL decoded, in lower case; else null. */
async function publicIdOf(personId: string): Promise<string | null> {
  try {
    const { linkedinUrl } = await getPerson(personId);
    const slug = /\/in\/([^/]+)\/?$/.exec(linkedinUrl ?? "")?.[1];
    return slug === undefined ? null : decodedLower(slug);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
    throw error;
  }
}

/** Where signals names the person whose public id is `slug`: sources, then others' evidence. */
async function scrub(slug: string): Promise<void> {
  for (const source of await tenantClient.signalSource.findMany({ orderBy: { id: "asc" } })) {
    const config = registeredSourceKinds().get(source.kind)?.scrub?.(source.config, slug);
    if (config === null || config === undefined) continue;
    if (source.enabled) await updateSource(source.id, { enabled: false });
    await tenantClient.signalSource.update({
      where: { id: source.id },
      data: { config, label: "" },
    });
    const open = { sourceId: source.id, status: { notIn: [...ENDED] } };
    for (const run of await tenantClient.signalRun.findMany({ where: open })) {
      await stopRun(source.id, run.id);
    }
  }
  const where = { url: { startsWith: NAMED_POSTS } };
  for (const row of await tenantClient.evidence.findMany({
    where,
    select: { id: true, url: true },
  })) {
    if (!namesAuthor(row.url, slug)) continue;
    const data = { url: unnamedPostUrl(row.url) ?? "", postExcerpt: null };
    await tenantClient.evidence.update({ where: { id: row.id }, data });
  }
}

/** A found company as the evidence route answers a research event: its name, site and reasons as kept. */
export type FoundCompanyReasons = {
  readonly name: string;
  readonly domain: string;
  readonly reasons: {
    kind: string;
    criterion: string | null;
    line: string;
    quote: string;
    url: string;
  }[];
};

/**
 * The found companies the research events name (gamma-wr-061), by id, in the caller's tenant run; an id
 * with no company, a company of another workspace included, has no entry. The reasons are read as
 * gamma-wr-050 stored them and cut to their five fields: nothing is judged here.
 */
export async function foundCompaniesOf(
  ids: readonly string[],
): Promise<Map<string, FoundCompanyReasons>> {
  if (ids.length === 0) return new Map();
  const rows = await tenantClient.signalFoundCompany.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true, domain: true, reasons: true },
  });
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return new Map(
    rows.map(({ id, name, domain, reasons }) => [
      id,
      {
        name,
        domain,
        reasons: (Array.isArray(reasons) ? (reasons as Record<string, unknown>[]) : []).map(
          (reason) => ({
            kind: text(reason.kind),
            criterion: typeof reason.criterion === "string" ? reason.criterion : null,
            line: text(reason.line),
            quote: text(reason.quote),
            url: text(reason.url),
          }),
        ),
      },
    ]),
  );
}
