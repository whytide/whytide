// contacts' person commands (README.md "Public interface"). Every command of contacts runs inside the
// caller's tenant run and opens none: it reads and writes through tenantClient, that run's transaction,
// scoped to its workspace (core/packages/db README "The tenant transaction and the scoped client").
// The api's routes call them in the request's run; imports and signals in their own.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { countryOf } from "./countries.ts";
import { hashOf } from "./hash.ts";
import { anyErased, writeHash } from "./hashes.ts";
import { normalizeLinkedinUrl } from "./linkedin-url.ts";
import { mergeFields, type Provenance, type ProvenanceMap, splitName } from "./provenance.ts";
import { listInput, parseInput, requireId, upsertPersonInput } from "./rules.ts";

export type Person = {
  readonly id: string;
  readonly workspaceId: string;
  readonly linkedinUrl: string;
  /** The provider's member id, keyed by adapter name. */
  readonly providerRefs: Readonly<Record<string, string>> | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly headline: string | null;
  readonly title: string | null;
  readonly companyName: string | null;
  readonly companyId: string | null;
  readonly locationText: string | null;
  /** ISO 3166-1 alpha-2, from locationText. */
  readonly locationCountry: string | null;
  readonly fieldProvenance: ProvenanceMap;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};
/** One source's values of a person: where they come from, and the profile. */
export type PersonFromSource = {
  source: Provenance["source"];
  provider: Provenance["provider"];
  profile: PersonProfile;
};
/** The input as the rules read it (rules.ts). */
export type ParsedPerson = z.output<typeof upsertPersonInput>;
/** What a source brings of a person: the LinkedIn port's profile fields, or a CSV row's. */
export type PersonProfile = {
  linkedinUrl: string;
  providerId?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  title?: string;
  companyName?: string;
  locationText?: string;
  /** When the source read the values; the provenance's `at`, now when absent. */
  fetchedAt?: Date;
};

/**
 * The person with the profile's normalized URL, created or merged field by field: each value the
 * source brings keeps its provenance, a newer one wins (provenance.ts); locationCountry follows
 * locationText. linkedin_url_invalid for a URL that is no profile; person_erased when the URL or the
 * provider id has an erased person's hash, and nothing is written.
 */
export async function upsertPersonFromSource(
  input: PersonFromSource,
): Promise<{ person: Person; created: boolean }> {
  const parsed = parseInput(upsertPersonInput, input);
  const linkedinUrl = normalizeLinkedinUrl(parsed.profile.linkedinUrl);
  if (linkedinUrl === null) throw new AppError(errors.linkedin_url_invalid);
  if (await anyErased(hashesOf(linkedinUrl, parsed))) throw new AppError(errors.person_erased);

  const stored = (await tenantClient.person.findFirst({ where: { linkedinUrl } })) as Person | null;
  const data = mergeInto(stored, parsed, linkedinUrl);
  if (stored !== null) {
    const person = await tenantClient.person.update({ where: { id: stored.id }, data });
    return { person: person as Person, created: false };
  }
  const { workspaceId } = currentTenant();
  const person = await tenantClient.person.create({
    data: { ...data, id: newId(ids.person), workspaceId, linkedinUrl },
  });
  return { person: person as Person, created: true };
}

/** The hashes that an erased person would have left of the URL and of the provider's id. */
export function hashesOf(linkedinUrl: string, { profile }: ParsedPerson): string[] {
  const { providerId } = profile;
  return [hashOf("url", linkedinUrl), ...(providerId ? [hashOf("pid", providerId)] : [])];
}

/**
 * The columns the input writes on the stored person, or on a new one: each value the source brings
 * keeps its provenance, a newer one wins (provenance.ts); locationCountry follows locationText.
 */
export function mergeInto(
  stored: Pick<Person, "providerRefs" | "fieldProvenance"> | null,
  { source, provider, profile }: ParsedPerson,
  linkedinUrl: string,
): Record<string, unknown> & { fieldProvenance: Record<string, Provenance> } {
  const names =
    profile.firstName || profile.lastName
      ? { firstName: profile.firstName, lastName: profile.lastName }
      : splitName(profile.name);
  const { providerId, headline, title, companyName, locationText } = profile;
  const providerRefs =
    provider && providerId ? { ...stored?.providerRefs, [provider]: providerId } : undefined;
  const stamp = { source, provider, at: (profile.fetchedAt ?? new Date()).toISOString() };
  const incoming = {
    linkedinUrl,
    providerRefs,
    ...names,
    headline,
    title,
    companyName,
    locationText,
  };
  const { values, provenance } = mergeFields(stored?.fieldProvenance ?? {}, incoming, stamp);
  if ("locationText" in values) {
    // The country follows the location it is read from, with the location's provenance.
    const country = countryOf(values.locationText as string);
    values.locationCountry = country;
    if (country === null) delete provenance.locationCountry;
    else provenance.locationCountry = provenance.locationText as Provenance;
  }
  return { ...values, fieldProvenance: provenance };
}

/** The person of the workspace; person_not_found otherwise. */
export async function getPerson(personId: string): Promise<Person> {
  const id = requireId("personId", personId);
  const person = await tenantClient.person.findFirst({ where: { id } });
  if (person === null) throw new AppError(errors.person_not_found);
  return person as Person;
}

/**
 * The workspace's person with the URL once normalized, or null: the deletion script's lookup.
 * linkedin_url_invalid for a URL that is no profile.
 */
export async function findPersonByLinkedinUrl(url: string): Promise<Person | null> {
  const linkedinUrl = normalizeLinkedinUrl(url);
  if (linkedinUrl === null) throw new AppError(errors.linkedin_url_invalid);
  return (await tenantClient.person.findFirst({ where: { linkedinUrl } })) as Person | null;
}

/**
 * A page of the workspace's people, newest first, `limit` of them after the `cursor`, the last id
 * of the page before; `nextCursor` is null on the last page.
 */
export async function listPersons(input: {
  limit: number;
  cursor?: string;
}): Promise<{ persons: Person[]; nextCursor: string | null }> {
  const { limit, cursor } = parseInput(listInput, input);
  const rows = await tenantClient.person.findMany({
    where: cursor === undefined ? {} : { id: { lt: cursor } },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  const persons = rows.slice(0, limit) as Person[];
  return { persons, nextCursor: rows.length > limit ? (persons.at(-1)?.id ?? null) : null };
}

/** What erasePerson deleted, by table, and the erased hash of the person's URL. */
export type PersonErasure = {
  readonly counts: Readonly<Record<"review_decisions" | "leads" | "persons", number>>;
  readonly hash: string;
};

/**
 * Deletes the person, its lead and the lead's review decisions, in the caller's run, and writes an
 * erased hash of its URL and of each provider id, so that no source adds it again
 * (upsertPersonFromSource answers person_erased): the step the deletion script runs last, in its
 * run, after the other modules' erasers (alpha-p10-030), which logs the counts and the URL's hash.
 * The one path that deletes a decision.
 */
export async function erasePerson(personId: string): Promise<PersonErasure> {
  const person = await getPerson(personId);
  const now = new Date();
  const memberIds = Object.values(person.providerRefs ?? {});
  const hash = hashOf("url", person.linkedinUrl);
  for (const value of [hash, ...memberIds.map((id) => hashOf("pid", id))]) {
    await writeHash(value, "erased", [], now);
  }
  const where = { personId: person.id };
  const decisions = await tenantClient.reviewDecision.deleteMany({ where });
  const leads = await tenantClient.lead.deleteMany({ where });
  await tenantClient.person.delete({ where: { id: person.id } });
  const counts = { review_decisions: decisions.count, leads: leads.count, persons: 1 };
  return { counts, hash };
}
