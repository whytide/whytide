// contacts' batched commands (README.md "Public interface"), for a chunk of an import: what
// upsertPersonFromSource and createLeadForPerson do for each input, in one INSERT … ON CONFLICT per
// call instead of about six queries a row, inside the caller's tenant run like every command of
// contacts (persons.ts). The same rules make the same rows: the merge is persons.ts's mergeInto,
// the source list lead.ts's mergeSource.
import { Prisma, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { holdUntil } from "./hold.ts";
import { type LeadSource, mergeSource, type SourceKind, sourceEntry } from "./lead.ts";
import type { Lead } from "./leads.ts";
import { normalizeLinkedinUrl } from "./linkedin-url.ts";
import {
  hashesOf,
  mergeInto,
  type ParsedPerson,
  type Person,
  type PersonFromSource,
} from "./persons.ts";
import { createLeadInput, parseInput, upsertPersonInput } from "./rules.ts";

/** A person written, or the code the one-row command would have thrown for the input. */
export type PersonUpsert =
  | { readonly person: Person; readonly created: boolean }
  | { readonly code: "contacts_input_invalid" | "linkedin_url_invalid" | "person_erased" };

type Refused = Extract<PersonUpsert, { code: string }>;
/** An input the rules took: its person's normalized URL, and the hashes an erasure would leave. */
type Checked = { linkedinUrl: string; parsed: ParsedPerson; hashes: readonly string[] };
/** How often a chunk writes again the persons another run created meanwhile, before it gives up. */
const ATTEMPTS = 3;
const json = (value: unknown) =>
  value === undefined || value === null ? null : JSON.stringify(value);

/**
 * upsertPersonFromSource for each input, in their order, in one read of the erased hashes, one of
 * the stored persons and one INSERT … ON CONFLICT: an answer per input. An input the one-row
 * command would refuse answers its code (contacts_input_invalid, linkedin_url_invalid,
 * person_erased) and writes nothing. Inputs with one URL merge one after the other, and each
 * answers the person as the call leaves it. A person that another run creates with one of the URLs
 * meanwhile is read and merged again, as the one-row command would have found it.
 */
export async function upsertPersonsFromSource(
  inputs: readonly PersonFromSource[],
): Promise<PersonUpsert[]> {
  const checked = inputs.map((input): Refused | Checked => {
    const parsed = upsertPersonInput.safeParse(input);
    if (!parsed.success) return { code: errors.contacts_input_invalid };
    // An import's row always has a profile and never an address: one without a profile, or with an
    // address, is the one-row command's (gamma-rf-050).
    const { linkedinUrl: url, email } = parsed.data.profile;
    if (url === undefined || email !== undefined) return { code: errors.contacts_input_invalid };
    const linkedinUrl = normalizeLinkedinUrl(url);
    if (linkedinUrl === null) return { code: errors.linkedin_url_invalid };
    return { parsed: parsed.data, linkedinUrl, hashes: hashesOf(linkedinUrl, parsed.data) };
  });
  const hashes = checked.flatMap((input) => ("code" in input ? [] : input.hashes));
  const erased = new Set(
    hashes.length === 0
      ? []
      : (
          await tenantClient.personHash.findMany({
            where: { hash: { in: hashes }, kind: "erased" },
            select: { hash: true },
          })
        ).map(({ hash }) => hash),
  );
  const answers = checked.map((input): Refused | Checked => {
    if ("code" in input || !input.hashes.some((hash) => erased.has(hash))) return input;
    return { code: errors.person_erased };
  });
  const toWrite = answers.flatMap((answer) => ("code" in answer ? [] : [answer]));
  const written = await writePersons(toWrite);
  const personIds = [...written.values()].map(({ id }) => id);
  const rows =
    personIds.length === 0
      ? []
      : ((await tenantClient.person.findMany({ where: { id: { in: personIds } } })) as Person[]);
  const byUrl = new Map(rows.map((person) => [person.linkedinUrl, person]));
  const seen = new Set<string>();
  return answers.map((answer) => {
    if ("code" in answer) return answer;
    const person = byUrl.get(answer.linkedinUrl);
    if (person === undefined) throw new Error("a person the chunk wrote is missing from its read");
    // Only the first input of a URL made the person: the next ones found it.
    const created = written.get(answer.linkedinUrl)?.created === true && !seen.has(person.id);
    seen.add(person.id);
    return { person, created };
  });
}

/**
 * The persons of the inputs, one row per URL whatever the inputs per URL: the stored persons read
 * in one query, each input merged in its order, then one INSERT … ON CONFLICT on the URL. A row
 * that another run inserted with the URL since the read is left as it is (the WHERE on the id), and
 * its inputs go round again with the row read; the ids and whether each URL's person is new.
 */
async function writePersons(
  inputs: readonly { linkedinUrl: string; parsed: ParsedPerson }[],
): Promise<Map<string, { id: string; created: boolean }>> {
  const done = new Map<string, { id: string; created: boolean }>();
  let pending = inputs;
  for (let attempt = 1; pending.length > 0; attempt++) {
    if (attempt > ATTEMPTS) throw new Error("other runs kept creating the chunk's persons first");
    const urls = [...new Set(pending.map(({ linkedinUrl }) => linkedinUrl))];
    const stored = (await tenantClient.person.findMany({
      where: { linkedinUrl: { in: urls } },
    })) as Person[];
    // Each read by its URL, so none is a person without a profile (gamma-rf-050).
    const state = new Map<string, Record<string, unknown>>(
      stored.flatMap((person) =>
        person.linkedinUrl === null ? [] : [[person.linkedinUrl, person] as const],
      ),
    );
    const wasStored = new Set(state.keys());
    for (const { linkedinUrl, parsed } of pending) {
      const before = (state.get(linkedinUrl) ?? null) as (Person & Record<string, unknown>) | null;
      const merged = mergeInto(before, parsed, linkedinUrl);
      state.set(linkedinUrl, { ...before, ...merged, id: before?.id ?? newId(ids.person) });
    }
    const returned = await insertPersons(urls.map((url) => state.get(url) ?? {}));
    for (const { linkedin_url: url, id, inserted } of returned) {
      // A stored person the read saw, deleted since and written again: erasePerson ran meanwhile.
      if (inserted && wasStored.has(url))
        throw new Error("a person the chunk read was deleted meanwhile");
      done.set(url, { id, created: inserted });
    }
    pending = pending.filter(({ linkedinUrl }) => !done.has(linkedinUrl));
  }
  return done;
}

/** One INSERT … ON CONFLICT of the persons' rows: the URLs written, their ids and which are new. */
function insertPersons(people: readonly Record<string, unknown>[]) {
  const { workspaceId } = currentTenant();
  const text = (field: string, person: Record<string, unknown>) =>
    (person[field] as string | null | undefined) ?? null;
  const values = people.map(
    (person) =>
      Prisma.sql`(${person.id}, ${workspaceId}, ${person.linkedinUrl},
        ${json(person.providerRefs)}::jsonb, ${text("firstName", person)}, ${text("lastName", person)},
        ${text("headline", person)}, ${text("title", person)}, ${text("companyName", person)},
        ${text("locationText", person)}, ${text("locationCountry", person)},
        ${json(person.fieldProvenance)}::jsonb, now(), now())`,
  );
  return tenantClient.$queryRaw<{ id: string; linkedin_url: string; inserted: boolean }[]>`
    INSERT INTO persons (id, workspace_id, linkedin_url, provider_refs, first_name, last_name,
      headline, title, company_name, location_text, location_country, field_provenance,
      created_at, updated_at)
    VALUES ${Prisma.join(values)}
    ON CONFLICT (workspace_id, linkedin_url) DO UPDATE SET
      provider_refs = EXCLUDED.provider_refs, first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name, headline = EXCLUDED.headline, title = EXCLUDED.title,
      company_name = EXCLUDED.company_name, location_text = EXCLUDED.location_text,
      location_country = EXCLUDED.location_country, field_provenance = EXCLUDED.field_provenance,
      updated_at = EXCLUDED.updated_at
    WHERE persons.id = EXCLUDED.id
    RETURNING id, linkedin_url, (xmax = 0) AS inserted`;
}

/** A lead's source for a person, as createLeadForPerson takes it. */
export type LeadForPerson = {
  personId: string;
  source: { kind: SourceKind; ref: string; at?: Date; label?: string; url?: string };
};

/**
 * createLeadForPerson for each input, in their order, in one INSERT … ON CONFLICT on the person: a
 * new lead pending, labeled by its first source and held for enrichment (hold.ts); a lead the person
 * has keeps its hold and gets each source it lacks
 * (by kind and ref), and the label and URL brought again for one it has, in the statement itself,
 * so that no other run's source is lost. An answer per input, the lead as the call leaves it; only
 * the first input of a new lead is `created`. contacts_input_invalid naming the input's fields, and
 * person_not_found when a person is not the workspace's, for the whole call: nothing is written.
 */
export async function createLeadsForPersons(
  inputs: readonly LeadForPerson[],
): Promise<{ lead: Lead; created: boolean }[]> {
  const parsed = inputs.map((input) => parseInput(createLeadInput, input));
  const sources = new Map<string, LeadSource[]>();
  for (const { personId, source } of parsed) {
    sources.set(personId, [...mergeSource(sources.get(personId) ?? [], sourceEntry(source))]);
  }
  if (sources.size === 0) return [];
  const personIds = [...sources.keys()];
  const found = await tenantClient.person.count({ where: { id: { in: personIds } } });
  if (found !== personIds.length) throw new AppError(errors.person_not_found);
  const created = new Set(
    (await insertLeads(sources)).flatMap((row) => (row.inserted ? [row.person_id] : [])),
  );
  const rows = await tenantClient.lead.findMany({ where: { personId: { in: personIds } } });
  const byPerson = new Map(rows.map((row) => [row.personId, row as unknown as Lead]));
  return parsed.map(({ personId }) => {
    const lead = byPerson.get(personId);
    if (lead === undefined) throw new Error("a lead the chunk wrote is missing from its read");
    const first = created.delete(personId);
    return { lead, created: first };
  });
}

/** One INSERT … ON CONFLICT of the leads: the persons written and which leads are new. */
function insertLeads(sources: ReadonlyMap<string, readonly LeadSource[]>) {
  const { workspaceId } = currentTenant();
  const hold = holdUntil(new Date());
  const values = [...sources].map(([personId, entries]) => {
    const [first] = entries as [LeadSource];
    return Prisma.sql`(${personId}, ${workspaceId}, ${first.kind}::lead_source_kind,
      ${json(entries)}::jsonb, ${first.at}::timestamptz, now(), ${hold}::timestamptz)`;
  });
  // The lead's sources, each taking the label and URL the call brings for its kind and ref, where
  // given (mergeSource); then the sources the lead lacks, in the call's order. updated_at moves with
  // any change.
  const renamed = Prisma.sql`(SELECT COALESCE(jsonb_agg(stored.entry || COALESCE((
      SELECT jsonb_strip_nulls(jsonb_build_object('label', given->'label', 'url', given->'url'))
      FROM jsonb_array_elements(EXCLUDED.sources) AS brought(given)
      WHERE given->'kind' = stored.entry->'kind' AND given->'ref' = stored.entry->'ref'), '{}')
    ORDER BY stored.n), '[]') FROM jsonb_array_elements(leads.sources) WITH ORDINALITY AS stored(entry, n))`;
  const missing = Prisma.sql`COALESCE((SELECT jsonb_agg(entry ORDER BY n)
    FROM jsonb_array_elements(EXCLUDED.sources) WITH ORDINALITY AS added(entry, n)
    WHERE NOT leads.sources @> jsonb_build_array(
      jsonb_build_object('kind', entry->'kind', 'ref', entry->'ref'))), '[]')`;
  return tenantClient.$queryRaw<{ person_id: string; inserted: boolean }[]>`
    INSERT INTO leads (person_id, workspace_id, source_label, sources, first_source_at, updated_at,
      enrichment_hold_until)
    VALUES ${Prisma.join(values)}
    ON CONFLICT (workspace_id, person_id) DO UPDATE SET
      sources = ${renamed} || ${missing},
      updated_at = CASE WHEN (${renamed} || ${missing}) = leads.sources THEN leads.updated_at
        ELSE now() END
    RETURNING person_id, (xmax = 0) AS inserted`;
}
