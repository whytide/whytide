// The never-contact list's commands (README.md "Public interface"; docs/flows.md "Suppression"),
// inside the caller's tenant run like every command of contacts (../persons.ts): an entry added by
// hand on a person (by profile or, since gamma-rf-040, by email address; a person without a profile
// by their addresses' hashes, gamma-rf-050) or a company, on every channel or on one, a customer or a
// competitor excluded by its domain, an opt-out, which is always on every channel, an exclusion
// lifted, and the list as the routes read it. An entry with the key of an active one is that one, returned unchanged, but for an
// exclusion list's (review-gaps): a hand add takes a csv entry over, as the adder's, so removing the
// list no longer lifts it; contacts.suppression_added is published in the same transaction, for a new
// entry only. Each add on every channel, new or not, sets `suppressed` on the leads the entry
// affects, in the same transaction (affected.ts). No entry is ever deleted: app holds no DELETE on
// the table.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { emailTarget } from "../emails.ts";
import { code, id as idRule, listInput, parseInput, requireId } from "../rules.ts";
import { suppressAffectedLeads } from "./affected.ts";
import {
  ADD_LAYERS,
  type AddLayer,
  ENTRY_SOURCES,
  type EntrySource,
  EVERY_CHANNEL,
  LIST_SOURCE,
  MANUAL_SOURCE,
  REMOVABLE_LAYERS,
  SUPPRESSION_CHANNELS,
  SUPPRESSION_KINDS,
  SUPPRESSION_RELATIONSHIPS,
  SUPPRESSION_VALUE_MAX,
  type SuppressionChannel,
  type SuppressionKind,
  type SuppressionLayer,
  type SuppressionMatchType,
  type SuppressionRelationship,
  type SuppressionSource,
  WRITE_ATTEMPTS,
} from "./constants.ts";
import {
  addressTarget,
  companyTarget,
  companyValueTarget,
  type EntryTarget,
  personTarget,
} from "./matching.ts";

export type SuppressionEntry = {
  readonly id: string;
  readonly workspaceId: string;
  readonly layer: SuppressionLayer;
  readonly matchType: SuppressionMatchType;
  /** hashOf of the normalized value: all that the match reads. */
  readonly hash: string;
  /** The profile or company page of a linkedin_url entry; null once the person is erased. */
  readonly linkedinUrl: string | null;
  readonly domain: string | null;
  /** The address of an email entry (gamma-rf-040); null once the person who held it is erased. */
  readonly email: string | null;
  /** all, or the one channel the entry stops; an opt-out's is always all. */
  readonly channel: SuppressionChannel;
  /** A relationship entry's kind, customer or competitor; null on every other layer. */
  readonly relationship: SuppressionRelationship | null;
  readonly source: SuppressionSource;
  /** A code: reply_opt_out for an opt-out found in a reply. */
  readonly reason: string | null;
  /** The user who added the entry; null for system. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly removedAt: Date | null;
  readonly removedBy: string | null;
  /** The exclusion list of a csv entry (gamma-p2-045); null on every other. */
  readonly exclusionListId: string | null;
};
/** A command's entry, and whether the command wrote it. */
export type AddedEntry = { readonly entry: SuppressionEntry; readonly created: boolean };
/**
 * An entry as the routes list it, with the person or company of the workspace it names, if any: an
 * email entry's person is the one who holds its address (person_email_hashes).
 */
export type ListedEntry = SuppressionEntry & {
  readonly personId: string | null;
  readonly companyId: string | null;
  /** The person's name, or the company's. */
  readonly displayName: string | null;
};

const addInput = z
  .strictObject({
    kind: z.enum(SUPPRESSION_KINDS),
    personId: idRule.optional(),
    companyId: idRule.optional(),
    value: z.string().max(SUPPRESSION_VALUE_MAX).optional(),
    layer: z.enum(ADD_LAYERS).default("blocklist"),
    channel: z.enum(SUPPRESSION_CHANNELS).default(EVERY_CHANNEL),
    relationship: z.enum(SUPPRESSION_RELATIONSHIPS).optional(),
    createdBy: idRule,
  })
  .superRefine((input, context) => {
    const person = input.kind === "person";
    const [own, other] = person
      ? (["personId", "companyId"] as const)
      : (["companyId", "personId"] as const);
    const fields: string[] = [];
    // Exactly one target: the person's or the company's id, or a value.
    if ((input[own] === undefined) === (input.value === undefined)) fields.push(own, "value");
    if (input[other] !== undefined) fields.push(other);
    // An opt-out is a person's own, and stops every channel (RB-20.3.1).
    if (input.layer === "opt_out" && !person) fields.push("layer");
    if (input.layer === "opt_out" && input.channel !== EVERY_CHANNEL) fields.push("channel");
    // A customer or a competitor is a company, excluded by a block, never by an opt-out.
    const related = input.relationship !== undefined;
    if (related && (person || input.layer === "opt_out")) fields.push("relationship");
    for (const field of fields) context.addIssue({ code: "custom", message: field, path: [field] });
  });
const optOutInput = z
  .strictObject({
    source: z.enum(ENTRY_SOURCES),
    reason: code.optional(),
    createdBy: idRule.optional(),
  })
  // A user records an opt-out by hand; the system, one found in a reply, as nobody.
  .refine((input) => (input.source === "manual") === (input.createdBy !== undefined), {
    path: ["createdBy"],
  });

/**
 * Adds a never-contact entry by hand: a person by `personId` (their profile URL; for a person without
 * a profile, an `email` entry on each of their addresses' hashes, with no address, the answer the
 * first, gamma-rf-050) or by `value` (a profile URL, else an email address, gamma-rf-040: an `email`
 * entry on its hash, the address kept in `email`, whose holder's lead it affects); a company by `companyId` (its domain, else its
 * LinkedIn page) or by `value` (a company page, else a domain). `layer` is `blocklist` unless the
 * route records a person's opt-out by hand.
 * `channel` is the one the entry stops, `all` when absent; an opt-out's is always `all`. A company's
 * `relationship`, customer or competitor, makes a `relationship` entry on its domain. An active entry
 * with the same key is returned unchanged, but an exclusion list's, which the add takes over
 * (writeEntry): source manual, no list, the adder its creator. On every channel, the leads it
 * affects become `suppressed` (affected.ts). suppression_target_invalid for a value that normalizes
 * to nothing or a company with neither domain nor page; person_not_found, company_not_found;
 * contacts_input_invalid for no target or two, an opt-out on one channel (`channel`), or a
 * relationship on a person, on an opt-out or on a company page (`relationship`).
 */
export async function addSuppression(input: {
  kind: SuppressionKind;
  personId?: string;
  companyId?: string;
  value?: string;
  layer?: AddLayer;
  channel?: SuppressionChannel;
  relationship?: SuppressionRelationship;
  createdBy: string;
}): Promise<AddedEntry> {
  const { channel, relationship, createdBy, ...given } = parseInput(addInput, input);
  const targets = await targetsOf(given);
  // A relationship entry matches a domain (the CHECK suppression_entries_relationship_match).
  if (relationship !== undefined && targets.some(({ matchType }) => matchType !== "domain")) {
    throw new AppError(errors.contacts_input_invalid, { details: { fields: ["relationship"] } });
  }
  const layer: SuppressionLayer = relationship === undefined ? given.layer : "relationship";
  const added: AddedEntry[] = [];
  for (const target of targets) {
    const entry = { layer, channel, relationship: relationship ?? null, target };
    added.push(await writeEntry({ ...entry, source: MANUAL_SOURCE, reason: null, createdBy }));
    await suppressAffectedLeads({ kind: given.kind, layer, channel, target, createdBy });
  }
  return firstOf(added);
}

/**
 * Adds an opt-out on the person's profile URL, on every channel: by hand (`manual`, with the user) or
 * found by the system (`system`, with its reason code: `reply_opt_out`, `email_unsubscribe`,
 * `notice_opt_out`, `complaint`). A person without a profile opts out on each of their addresses'
 * hashes, with no address (gamma-rf-050); the answer is the first entry, created when any was. An
 * opt-out is never removed. An active one is returned unchanged. The person's lead becomes
 * `suppressed` (affected.ts). person_not_found.
 */
export async function addOptOut(
  personId: string,
  input: { source: EntrySource; reason?: string; createdBy?: string },
): Promise<AddedEntry> {
  const id = requireId("personId", personId);
  const { source, reason, createdBy } = parseInput(optOutInput, input);
  const by = createdBy ?? null;
  const added: AddedEntry[] = [];
  for (const target of await targetsOfPerson(id)) {
    added.push(
      await writeEntry({
        layer: "opt_out",
        channel: EVERY_CHANNEL,
        relationship: null,
        target,
        source,
        reason: reason ?? null,
        createdBy: by,
      }),
    );
    const affected = { kind: "person", layer: "opt_out", channel: EVERY_CHANNEL } as const;
    await suppressAffectedLeads({ ...affected, target, createdBy: by });
  }
  return firstOf(added);
}

/** A command's answer for the entries it wrote on one target or more: the first, created if any was. */
function firstOf(added: readonly AddedEntry[]): AddedEntry {
  const [first] = added;
  if (first === undefined) throw new Error("a never-contact command wrote no entry");
  return { entry: first.entry, created: added.some(({ created }) => created) };
}

/**
 * Lifts an exclusion, an active blocklist or relationship entry: sets its removed_at and removed_by,
 * and keeps the row, so that the list as it stood at any instant can be read again (checks.ts
 * suppressedAt). An exclusion list's entry is lifted too, whatever other list names its domain: a
 * person's explicit act (review-gaps). suppression_not_removable for an opt-out;
 * suppression_not_found for an id of no active entry.
 */
export async function removeSuppression(id: string, input: { removedBy: string }): Promise<void> {
  const entryId = requireId("id", id);
  const removedBy = requireId("removedBy", input?.removedBy);
  const stored = await tenantClient.suppressionEntry.findFirst({
    where: { id: entryId },
    select: { layer: true, removedAt: true },
  });
  if (stored === null || stored.removedAt !== null)
    throw new AppError(errors.suppression_not_found);
  const removable = REMOVABLE_LAYERS.find((layer) => layer === stored.layer);
  if (removable === undefined) throw new AppError(errors.suppression_not_removable);
  const { count } = await tenantClient.suppressionEntry.updateMany({
    where: { id: entryId, layer: { in: [...REMOVABLE_LAYERS] }, removedAt: null },
    data: { removedAt: new Date(), removedBy },
  });
  if (count === 0) throw new AppError(errors.suppression_not_found);
}

/**
 * A page of the workspace's active entries, newest first, `limit` of them after the `cursor`, the
 * last id of the page before, each with the person or company it names; `nextCursor` is null on
 * the last page.
 */
export async function listSuppression(input: {
  limit: number;
  cursor?: string;
}): Promise<{ entries: ListedEntry[]; nextCursor: string | null }> {
  const { limit, cursor } = parseInput(listInput, input);
  const rows = await tenantClient.suppressionEntry.findMany({
    where: cursor === undefined ? { removedAt: null } : { removedAt: null, id: { lt: cursor } },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit) as SuppressionEntry[];
  const nextCursor = rows.length > limit ? (page.at(-1)?.id ?? null) : null;
  return { entries: await describeEntries(page), nextCursor };
}

/**
 * The entries with the person or company of the workspace each names, by its raw value, or for an
 * email entry by the holder of its hash, and the name: three queries for the lot at most. An entry
 * whose value erasure emptied names nobody, as an email entry whose address nobody holds.
 */
export async function describeEntries(
  entries: readonly SuppressionEntry[],
): Promise<ListedEntry[]> {
  const urls = [...new Set(entries.flatMap(({ linkedinUrl }) => linkedinUrl ?? []))];
  const domains = [...new Set(entries.flatMap(({ domain }) => domain ?? []))];
  const emailHashes = [
    ...new Set(entries.flatMap(({ matchType, hash }) => (matchType === "email" ? hash : []))),
  ];
  const holders =
    emailHashes.length === 0
      ? []
      : await tenantClient.personEmailHash.findMany({
          where: { hash: { in: emailHashes } },
          select: { hash: true, personId: true },
        });
  const holderIds = [...new Set(holders.map(({ personId }) => personId))];
  const personKeys = [
    ...(urls.length === 0 ? [] : [{ linkedinUrl: { in: urls } }]),
    ...(holderIds.length === 0 ? [] : [{ id: { in: holderIds } }]),
  ];
  const persons =
    personKeys.length === 0
      ? []
      : await tenantClient.person.findMany({
          where: { OR: personKeys },
          select: { id: true, linkedinUrl: true, firstName: true, lastName: true },
        });
  const keys = [
    ...(urls.length === 0 ? [] : [{ linkedinUrl: { in: urls } }]),
    ...(domains.length === 0 ? [] : [{ domain: { in: domains } }]),
  ];
  const companies =
    keys.length === 0
      ? []
      : await tenantClient.workspaceCompany.findMany({
          where: { OR: keys },
          select: { id: true, name: true, domain: true, linkedinUrl: true },
        });
  const personBy = new Map(persons.map((person) => [person.linkedinUrl, person]));
  const personById = new Map(persons.map((person) => [person.id, person]));
  const holderBy = new Map(holders.map(({ hash, personId }) => [hash, personById.get(personId)]));
  const companyBy = new Map(
    companies.flatMap((company) => [
      ...(company.linkedinUrl === null ? [] : [[company.linkedinUrl, company] as const]),
      ...(company.domain === null ? [] : [[`domain:${company.domain}`, company] as const]),
    ]),
  );
  return entries.map((entry) => {
    const person =
      entry.matchType === "email"
        ? holderBy.get(entry.hash)
        : entry.linkedinUrl === null
          ? undefined
          : personBy.get(entry.linkedinUrl);
    if (person !== undefined) {
      const displayName = [person.firstName, person.lastName].filter(Boolean).join(" ") || null;
      return { ...entry, personId: person.id, companyId: null, displayName };
    }
    const key = entry.domain === null ? entry.linkedinUrl : `domain:${entry.domain}`;
    const company = key === null ? undefined : companyBy.get(key);
    if (company !== undefined) {
      return { ...entry, personId: null, companyId: company.id, displayName: company.name };
    }
    return { ...entry, personId: null, companyId: null, displayName: null };
  });
}

/** What the entries are written on, from the input's one target: one, but for a person by id. */
async function targetsOf(input: {
  kind: SuppressionKind;
  personId?: string;
  companyId?: string;
  value?: string;
}): Promise<EntryTarget[]> {
  const { kind, personId, companyId, value = "" } = input;
  if (kind === "person" && personId !== undefined) return targetsOfPerson(personId);
  // A person's value: a profile, else an email address (gamma-rf-040).
  if (kind === "person") return [personTarget(value) ?? emailTarget(value) ?? invalidTarget()];
  if (companyId === undefined) return [companyValueTarget(value) ?? invalidTarget()];
  const company = await tenantClient.workspaceCompany.findFirst({
    where: { id: companyId },
    select: { domain: true, linkedinUrl: true },
  });
  if (company === null) throw new AppError(errors.company_not_found);
  return [companyTarget(company) ?? invalidTarget()];
}

/**
 * What a person's entries are written on: their profile URL, else, for a person without a profile,
 * each of their addresses' hashes, the earliest recorded first, with no address (gamma-rf-050);
 * person_not_found for no person of the workspace.
 */
async function targetsOfPerson(personId: string): Promise<EntryTarget[]> {
  const person = await tenantClient.person.findFirst({
    where: { id: personId },
    select: { linkedinUrl: true },
  });
  if (person === null) throw new AppError(errors.person_not_found);
  if (person.linkedinUrl !== null) return [personTarget(person.linkedinUrl) ?? invalidTarget()];
  const addresses = await tenantClient.personEmailHash.findMany({
    where: { personId },
    select: { hash: true },
    orderBy: [{ createdAt: "asc" }, { hash: "asc" }],
  });
  if (addresses.length === 0) invalidTarget();
  return addresses.map(({ hash }) => addressTarget(hash));
}

function invalidTarget(): never {
  throw new AppError(errors.suppression_target_invalid);
}

/**
 * Writes the entry unless an active one has its key (the migration's suppression_entries_active_key,
 * as INSERT … ON CONFLICT DO NOTHING, so two runs adding it at once keep one row), and reads the
 * active one back; publishes contacts.suppression_added for a new one. A hand add (`manual`) that
 * meets an exclusion list's entry takes it over (takeOver). An active entry removed between the
 * statements is written again, WRITE_ATTEMPTS times at most.
 */
async function writeEntry(input: {
  layer: SuppressionLayer;
  channel: SuppressionChannel;
  relationship: SuppressionRelationship | null;
  target: EntryTarget;
  source: EntrySource;
  reason: string | null;
  createdBy: string | null;
}): Promise<AddedEntry> {
  const { workspaceId } = currentTenant();
  const { layer, channel, relationship, target, source, reason, createdBy } = input;
  const { matchType, hash, linkedinUrl, domain, email } = target;
  const row = { id: newId(ids.suppression_entry), workspaceId, layer, matchType, hash, channel };
  const values = {
    ...row,
    relationship,
    linkedinUrl,
    domain,
    email,
    source,
    reason,
    createdBy,
    createdAt: new Date(),
  };
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const { count } = await tenantClient.suppressionEntry.createMany({
      data: [values],
      skipDuplicates: true,
    });
    const entry = await tenantClient.suppressionEntry.findFirst({
      where: { layer, matchType, hash, channel, removedAt: null },
    });
    if (entry === null) continue;
    if (count === 0 && source === MANUAL_SOURCE && entry.source === LIST_SOURCE) {
      const taken = await takeOver(entry.id, createdBy);
      // Removed meanwhile, or taken by another add: read again.
      if (taken === null) continue;
      return { entry: taken, created: false };
    }
    if (count === 1) {
      const payload = { suppressionId: entry.id, layer, channel };
      await publish(
        outboxWriter(tenantClient, workspaceId),
        events["contacts.suppression_added"],
        payload,
      );
    }
    return { entry: entry as SuppressionEntry, created: count === 1 };
  }
  throw new Error("the active entry with this key kept being removed meanwhile");
}

/**
 * The exclusion list's entry made the hand add's (review-gaps): source manual, no list, created by
 * the adder, the rest as stored, so the CHECK suppression_entries_csv_list holds and a removal of the
 * list no longer touches it. One update conditional on the entry still being an active csv one: it
 * waits for a removal that holds the row and then reads it as committed, so it never takes over an
 * entry the removal lifted, and the removal skips an entry it took over. Null when it matched none.
 */
async function takeOver(id: string, createdBy: string | null): Promise<SuppressionEntry | null> {
  const [taken] = await tenantClient.suppressionEntry.updateManyAndReturn({
    where: { id, source: LIST_SOURCE, removedAt: null },
    data: { source: MANUAL_SOURCE, exclusionListId: null, createdBy },
  });
  return (taken as SuppressionEntry | undefined) ?? null;
}
