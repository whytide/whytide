// contacts' person commands (README.md "Public interface"). Every command of contacts runs inside the
// caller's tenant run and opens none: it reads and writes through tenantClient, that run's transaction,
// scoped to its workspace (core/packages/db README "The tenant transaction and the scoped client").
// The api's routes call them in the request's run; imports and signals in their own.
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { countryOf, key } from "./countries.ts";
import { emailTarget, recordEmailHash } from "./emails.ts";
import { hashOf } from "./hash.ts";
import { anyErased, writeHash } from "./hashes.ts";
import { normalizeLinkedinUrl } from "./linkedin-url.ts";
import {
  mergeFields,
  type Provenance,
  type ProvenanceMap,
  type Source,
  splitName,
} from "./provenance.ts";
import { listInput, parseInput, requireId, upsertPersonInput } from "./rules.ts";
import { type EntryTarget, profileHash } from "./suppression/matching.ts";

export type Person = {
  readonly id: string;
  readonly workspaceId: string;
  /**
   * The LinkedIn profile, normalized; null for a person known by an email address alone, whose
   * hash contacts keeps (person_email_hashes; gamma-rf-050). Never null with no address.
   */
  readonly linkedinUrl: string | null;
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
  /** The latest outbound touch, read by lastTouchAt (suppression/checks.ts); null before the first. */
  readonly lastTouchAt?: Date | null;
};
/** One source's values of a person: where they come from, and the profile. */
export type PersonFromSource = {
  source: Source;
  provider: Provenance["provider"];
  profile: PersonProfile;
};
/** The input as the rules read it (rules.ts). */
export type ParsedPerson = z.output<typeof upsertPersonInput>;
/**
 * What a source brings of a person: their LinkedIn profile URL, an email address they hold, or both
 * (gamma-rf-050), never neither, and the LinkedIn port's profile fields, or a CSV row's.
 */
export type PersonProfile = PersonKeys & ProfileFields;
/** A person's keys as a source brings them: a URL, an address kept as its hash only, or both. */
type PersonKeys =
  | { linkedinUrl: string; email?: string }
  | { linkedinUrl?: undefined; email: string };
type ProfileFields = {
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
 * The person with the profile's normalized URL or who holds its email address (gamma-rf-050),
 * created or merged field by field: each value the source brings keeps its provenance, a newer one
 * wins (provenance.ts); locationCountry follows locationText. A person the address finds takes the
 * URL when they have none. The address is recorded as recordPersonEmail records it, its hash only
 * (emails.ts), and a person created with an address alone has no URL, in the run that records its
 * hash. linkedin_url_invalid for a URL that is no profile; contacts_input_invalid naming
 * `profile.email` for a text that is no address, and both fields for neither; person_erased when the
 * URL, the provider id or the address has an erased person's hash; person_conflict when the URL and
 * the address find two persons, or the address's person has another URL. Nothing is written on a
 * refusal.
 */
export async function upsertPersonFromSource(
  input: PersonFromSource,
): Promise<{ person: Person; created: boolean }> {
  const parsed = parseInput(upsertPersonInput, input);
  const { linkedinUrl, email } = keysOf(parsed);
  const hashes = [...hashesOf(linkedinUrl, parsed), ...(email === null ? [] : [email.hash])];
  if (await anyErased(hashes)) throw new AppError(errors.person_erased);

  const found = await storedOf(linkedinUrl, email);
  const stored = found?.person ?? null;
  const data = mergeInto(stored, parsed, linkedinUrl);
  if (stored !== null) {
    // The address first, so that a conflict meanwhile leaves the person as it was.
    if (email !== null && !found?.holdsEmail) await recordOn(stored.id, email, false);
    const person = await tenantClient.person.update({ where: { id: stored.id }, data });
    return { person: person as Person, created: false };
  }
  const { workspaceId } = currentTenant();
  const person = await tenantClient.person.create({
    data: { ...data, id: newId(ids.person), workspaceId, linkedinUrl },
  });
  if (email !== null) await recordOn(person.id, email, true);
  return { person: person as Person, created: true };
}

/**
 * The input's keys: its URL normalized and its address's target (emails.ts), each null when not
 * given. linkedin_url_invalid, contacts_input_invalid naming `profile.email`.
 */
function keysOf({ profile }: ParsedPerson) {
  const linkedinUrl =
    profile.linkedinUrl === undefined ? null : normalizeLinkedinUrl(profile.linkedinUrl);
  if (profile.linkedinUrl !== undefined && linkedinUrl === null) {
    throw new AppError(errors.linkedin_url_invalid);
  }
  const email = profile.email === undefined ? null : emailTarget(profile.email);
  if (profile.email !== undefined && email === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["profile.email"] } });
  }
  return { linkedinUrl, email };
}

/**
 * The stored person the keys find, and whether they hold the address: the person with the URL, the
 * holder of the address's hash, the one person both find; null for none. person_conflict for two
 * persons, or for a holder of the address with another URL.
 */
async function storedOf(
  linkedinUrl: string | null,
  email: EntryTarget | null,
): Promise<{ person: Person; holdsEmail: boolean } | null> {
  const byUrl =
    linkedinUrl === null
      ? null
      : ((await tenantClient.person.findFirst({ where: { linkedinUrl } })) as Person | null);
  const held =
    email === null
      ? null
      : await tenantClient.personEmailHash.findFirst({
          where: { hash: email.hash },
          select: { personId: true },
        });
  if (held === null) return byUrl === null ? null : { person: byUrl, holdsEmail: false };
  if (byUrl !== null) {
    if (byUrl.id !== held.personId) throw new AppError(errors.person_conflict);
    return { person: byUrl, holdsEmail: true };
  }
  const holder = (await tenantClient.person.findFirst({
    where: { id: held.personId },
  })) as Person | null;
  if (holder === null) return null;
  if (linkedinUrl !== null && holder.linkedinUrl !== null) {
    throw new AppError(errors.person_conflict);
  }
  return { person: holder, holdsEmail: true };
}

/**
 * The address's hash recorded for the person (emails.ts recordEmailHash). person_conflict when
 * another person of the workspace took it, or an erased person left it, meanwhile; a person `created`
 * for it in this run is deleted first, so that no person is ever left with neither key.
 */
async function recordOn(personId: string, email: EntryTarget, created: boolean): Promise<void> {
  const { holder } = await recordEmailHash(personId, email);
  if (holder === "self") return;
  if (created) await tenantClient.person.delete({ where: { id: personId } });
  throw new AppError(errors.person_conflict);
}

/**
 * The hashes that an erased person would have left of the URL, if any, and of the provider's id;
 * an address's is the caller's.
 */
export function hashesOf(linkedinUrl: string | null, { profile }: ParsedPerson): string[] {
  const { providerId } = profile;
  return [
    ...(linkedinUrl === null ? [] : [hashOf("url", linkedinUrl)]),
    ...(providerId ? [hashOf("pid", providerId)] : []),
  ];
}

/**
 * The columns the input writes on the stored person, or on a new one: each value the source brings
 * keeps its provenance, a newer one wins (provenance.ts); locationCountry follows locationText. A
 * null URL, an input with an address alone, writes none; the address is never a column.
 */
export function mergeInto(
  stored: Pick<Person, "providerRefs" | "fieldProvenance" | "locationText"> | null,
  { source, provider, profile }: ParsedPerson,
  linkedinUrl: string | null,
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
    // The country follows the location it is read from, with the location's provenance. One the
    // list cannot read keeps the country recorded for the same text (enrichment's, gamma-en-075).
    const text = values.locationText as string;
    const country = countryOf(text);
    const same = stored?.locationText != null && key(stored.locationText) === key(text);
    if (country !== null) {
      values.locationCountry = country;
      provenance.locationCountry = provenance.locationText as Provenance;
    } else if (!same) {
      values.locationCountry = null;
      delete provenance.locationCountry;
    }
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
 * The workspace's person who holds the address, by its hash, or null: the deletion script's lookup
 * by email (gamma-rf-050). contacts_input_invalid naming `address` for a text that is no address.
 */
export async function findPersonByEmail(address: string): Promise<Person | null> {
  const target = emailTarget(address);
  if (target === null) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["address"] } });
  }
  const held = await tenantClient.personEmailHash.findFirst({
    where: { hash: target.hash },
    select: { personId: true },
  });
  if (held === null) return null;
  return (await tenantClient.person.findFirst({ where: { id: held.personId } })) as Person | null;
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

/** A person as personNames answers one: the name and the title only, no id of a company, URL or place. */
export type PersonName = {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly title: string | null;
};

/**
 * The names and titles of the workspace's persons with these ids (a person erased or of another workspace
 * is not in the answer). signals' Companies found list names the leads found at a company (gamma-wr-110).
 */
export async function personNames(personIds: readonly string[]): Promise<PersonName[]> {
  if (personIds.length === 0) return [];
  return tenantClient.person.findMany({
    where: { id: { in: [...personIds] } },
    select: { id: true, firstName: true, lastName: true, title: true },
  });
}

/** A colleague as colleaguesOf answers one: the names only, no id or URL. */
export type Colleague = { readonly firstName: string | null; readonly lastName: string | null };

/**
 * The names of the workspace's other persons at the person's company: those with its companyId, or,
 * for a person without one, those whose companyName is the same, case aside; none for a person with
 * neither. Never the person. messaging's colleague-signal gate (beta-p3-020); person_not_found.
 */
export async function colleaguesOf(personId: string): Promise<Colleague[]> {
  const { id, companyId, companyName } = await getPerson(personId);
  const company =
    companyId !== null
      ? { companyId }
      : companyName
        ? { companyName: { equals: companyName, mode: "insensitive" as const } }
        : null;
  if (company === null) return [];
  return tenantClient.person.findMany({
    where: { ...company, id: { not: id } },
    select: { firstName: true, lastName: true },
    orderBy: { id: "asc" },
  });
}

/** What erasePerson deleted, by table, and the erased hash that names the person. */
export type PersonErasure = {
  readonly counts: Readonly<
    Record<"person_email_hashes" | "review_decisions" | "leads" | "persons", number>
  >;
  /**
   * The URL's erased hash, else, for a person without a profile, their first address's, the earliest
   * recorded (gamma-rf-050); null with `writeErasedHash: false`, which writes none.
   */
  readonly hash: string | null;
};

/** What erasePerson's `beforeDelete` reads of the person, under the row's lock. */
export type LockedPerson = {
  readonly createdAt: Date;
  readonly lastTouchAt: Date | null;
  readonly locationCountry: string | null;
};

/**
 * Deletes the person, its lead and the lead's review decisions, in the caller's run, and writes an
 * erased hash of its URL and of each provider id, so that no source adds it again
 * (upsertPersonFromSource answers person_erased): the step the deletion script runs last, in its
 * run, after the other modules' erasers (alpha-p10-030), which logs the counts and the URL's hash.
 * The one path that deletes a decision, and a status change of the lead's (beta-p2-030), which the
 * counts leave out, as privacy's log has them. Its never-contact entries and opt-outs, in both layers,
 * lose their profile URL and keep their hash, which is all the match reads (beta-p2-010); a company's
 * entries stay as they are. The hashes of its email addresses (gamma-rf-040) go, counted, each kept as
 * an erased hash too, so that no other person of the workspace takes the address (recordPersonEmail
 * answers other_person); the entries on them lose their address and keep their hash. With
 * `writeErasedHash: false`, privacy's 30-day rule (gamma-p7-010), the same rows go and no erased hash
 * is written or answered, so a later source may add the person, or another hold the address, again.
 * With `beforeDelete`, the rule's last look: the person's row is read under its lock (FOR UPDATE) right
 * before the delete, which takes that lock anyway, and handed to it; a touch another run is still
 * writing is waited for, then read. What it throws ends the erasure, and the caller's run rolls back.
 * A person without a profile (gamma-rf-050) is erased the same way, with no URL: the erased hashes
 * are their addresses' and their provider ids', and the hash answered their first address's.
 * The order: the hashes, the entries' URLs and addresses, the address hashes, the decisions, the
 * status changes, the lead (whose lock the caller holds), then the person's row. A writer of
 * last_touch_at (campaigns' settles, inbox's echo) takes none of those rows after the person's, so
 * the lock adds no cycle.
 */
export async function erasePerson(
  personId: string,
  options: {
    readonly writeErasedHash?: boolean;
    readonly beforeDelete?: (person: LockedPerson) => Promise<void>;
  } = {},
): Promise<PersonErasure> {
  const person = await getPerson(personId);
  const where = { personId: person.id };
  const emails = (
    await tenantClient.personEmailHash.findMany({
      where,
      select: { hash: true },
      orderBy: [{ createdAt: "asc" }, { hash: "asc" }],
    })
  ).map(({ hash: value }) => value);
  const keepsHash = options.writeErasedHash !== false;
  const urlHash = person.linkedinUrl === null ? null : hashOf("url", person.linkedinUrl);
  if (keepsHash) {
    const now = new Date();
    const memberIds = Object.values(person.providerRefs ?? {});
    const pids = memberIds.map((id) => hashOf("pid", id));
    for (const value of [...(urlHash === null ? [] : [urlHash]), ...pids, ...emails]) {
      await writeHash(value, "erased", [], now);
    }
  }
  const hash = keepsHash ? (urlHash ?? emails[0] ?? null) : null;
  if (person.linkedinUrl !== null) {
    // The profile's hash is the URL's, as an entry on the person is written (suppression/matching.ts).
    await tenantClient.suppressionEntry.updateMany({
      where: { hash: profileHash(person.linkedinUrl), linkedinUrl: { not: null } },
      data: { linkedinUrl: null },
    });
  }
  if (emails.length > 0) {
    await tenantClient.suppressionEntry.updateMany({
      where: { hash: { in: emails }, email: { not: null } },
      data: { email: null },
    });
  }
  const addresses = await tenantClient.personEmailHash.deleteMany({ where });
  const decisions = await tenantClient.reviewDecision.deleteMany({ where });
  await tenantClient.leadStatusChange.deleteMany({ where });
  const leads = await tenantClient.lead.deleteMany({ where });
  if (options.beforeDelete) await options.beforeDelete(await lockedPerson(person.id));
  await tenantClient.person.delete({ where: { id: person.id } });
  const counts = {
    person_email_hashes: addresses.count,
    review_decisions: decisions.count,
    leads: leads.count,
    persons: 1,
  };
  return { counts, hash };
}

/**
 * The person's row, locked until the run ends: a run that wrote it and is still open is waited for,
 * and its committed values are read (READ COMMITTED). person_not_found once another run deleted it.
 */
async function lockedPerson(id: string): Promise<LockedPerson> {
  const { workspaceId } = currentTenant();
  const [row] = await tenantClient.$queryRaw<LockedPerson[]>`
    SELECT created_at AS "createdAt", last_touch_at AS "lastTouchAt",
      location_country AS "locationCountry"
    FROM persons WHERE workspace_id = ${workspaceId} AND id = ${id}
    FOR UPDATE`;
  if (row === undefined) throw new AppError(errors.person_not_found);
  return row;
}
