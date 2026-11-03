// The never-contact list's commands (README.md "Public interface"; docs/flows.md "Suppression"),
// inside the caller's tenant run like every command of contacts (../persons.ts): an entry added by
// hand on a person or a company, an opt-out, a block removed, and the list as the routes read it.
// An entry with the key of an active one is that one, returned unchanged; contacts.suppression_added
// is published in the same transaction, for a new entry only. Each add, new or not, sets
// `suppressed` on the leads the entry affects, in the same transaction (affected.ts).
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { code, id as idRule, listInput, parseInput, requireId } from "../rules.ts";
import { suppressAffectedLeads } from "./affected.ts";
import {
  SUPPRESSION_KINDS,
  SUPPRESSION_LAYERS,
  SUPPRESSION_SOURCES,
  SUPPRESSION_VALUE_MAX,
  type SuppressionKind,
  type SuppressionLayer,
  type SuppressionMatchType,
  type SuppressionSource,
  WRITE_ATTEMPTS,
} from "./constants.ts";
import { companyTarget, companyValueTarget, type EntryTarget, personTarget } from "./matching.ts";

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
  readonly channel: "all";
  readonly source: SuppressionSource;
  /** A code: reply_opt_out for an opt-out found in a reply. */
  readonly reason: string | null;
  /** The user who added the entry; null for system. */
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly removedAt: Date | null;
  readonly removedBy: string | null;
};
/** A command's entry, and whether the command wrote it. */
export type AddedEntry = { readonly entry: SuppressionEntry; readonly created: boolean };
/** An entry as the routes list it, with the person or company of the workspace it names, if any. */
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
    layer: z.enum(SUPPRESSION_LAYERS).default("blocklist"),
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
    // An opt-out is a person's own.
    if (input.layer === "opt_out" && !person) fields.push("layer");
    for (const field of fields) context.addIssue({ code: "custom", message: field, path: [field] });
  });
const optOutInput = z
  .strictObject({
    source: z.enum(SUPPRESSION_SOURCES),
    reason: code.optional(),
    createdBy: idRule.optional(),
  })
  // A user records an opt-out by hand; the system, one found in a reply, as nobody.
  .refine((input) => (input.source === "manual") === (input.createdBy !== undefined), {
    path: ["createdBy"],
  });

/**
 * Adds a never-contact entry by hand: a person by `personId` (their profile URL) or by `value` (a
 * profile URL); a company by `companyId` (its domain, else its LinkedIn page) or by `value` (a company
 * page, else a domain). `layer` is `blocklist` unless the route records a person's opt-out by hand.
 * An active entry with the same key is returned unchanged. The leads it affects become
 * `suppressed` (affected.ts). suppression_target_invalid for a value that normalizes to nothing or
 * a company with neither domain nor page; person_not_found, company_not_found;
 * contacts_input_invalid for no target or two.
 */
export async function addSuppression(input: {
  kind: SuppressionKind;
  personId?: string;
  companyId?: string;
  value?: string;
  layer?: SuppressionLayer;
  createdBy: string;
}): Promise<AddedEntry> {
  const { layer, createdBy, ...given } = parseInput(addInput, input);
  const target = await targetOf(given);
  const added = await writeEntry({ layer, target, source: "manual", reason: null, createdBy });
  await suppressAffectedLeads({ kind: given.kind, layer, target, createdBy });
  return added;
}

/**
 * Adds an opt-out on the person's profile URL: by hand (`manual`, with the user) or found in a reply
 * (`system`, with its reason code, `reply_opt_out`). An opt-out is never removed. An active one is
 * returned unchanged. The person's lead becomes `suppressed` (affected.ts). person_not_found.
 */
export async function addOptOut(
  personId: string,
  input: { source: SuppressionSource; reason?: string; createdBy?: string },
): Promise<AddedEntry> {
  const id = requireId("personId", personId);
  const { source, reason, createdBy } = parseInput(optOutInput, input);
  const target = personTarget(await profileOf(id)) ?? invalidTarget();
  const by = createdBy ?? null;
  const added = await writeEntry({
    layer: "opt_out",
    target,
    source,
    reason: reason ?? null,
    createdBy: by,
  });
  await suppressAffectedLeads({ kind: "person", layer: "opt_out", target, createdBy: by });
  return added;
}

/**
 * Removes an active blocklist entry: sets its removed_at and removed_by, and keeps the row, so that
 * the list as it stood at any instant can be read again (checks.ts suppressedAt).
 * suppression_not_removable for an opt-out; suppression_not_found for an id of no active entry.
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
  if (stored.layer === "opt_out") throw new AppError(errors.suppression_not_removable);
  const { count } = await tenantClient.suppressionEntry.updateMany({
    where: { id: entryId, layer: "blocklist", removedAt: null },
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
 * The entries with the person or company of the workspace each names, by its raw value, and the
 * name: two queries for the lot. An entry whose value erasure emptied names nobody.
 */
export async function describeEntries(
  entries: readonly SuppressionEntry[],
): Promise<ListedEntry[]> {
  const urls = [...new Set(entries.flatMap(({ linkedinUrl }) => linkedinUrl ?? []))];
  const domains = [...new Set(entries.flatMap(({ domain }) => domain ?? []))];
  const persons =
    urls.length === 0
      ? []
      : await tenantClient.person.findMany({
          where: { linkedinUrl: { in: urls } },
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
  const companyBy = new Map(
    companies.flatMap((company) => [
      ...(company.linkedinUrl === null ? [] : [[company.linkedinUrl, company] as const]),
      ...(company.domain === null ? [] : [[`domain:${company.domain}`, company] as const]),
    ]),
  );
  return entries.map((entry) => {
    const person = entry.linkedinUrl === null ? undefined : personBy.get(entry.linkedinUrl);
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

/** What the entry is written on, from the input's one target. */
async function targetOf(input: {
  kind: SuppressionKind;
  personId?: string;
  companyId?: string;
  value?: string;
}): Promise<EntryTarget> {
  const { kind, personId, companyId, value = "" } = input;
  if (kind === "person") {
    const url = personId === undefined ? value : await profileOf(personId);
    return personTarget(url) ?? invalidTarget();
  }
  if (companyId === undefined) return companyValueTarget(value) ?? invalidTarget();
  const company = await tenantClient.workspaceCompany.findFirst({
    where: { id: companyId },
    select: { domain: true, linkedinUrl: true },
  });
  if (company === null) throw new AppError(errors.company_not_found);
  return companyTarget(company) ?? invalidTarget();
}

/** The person's profile URL; person_not_found for no person of the workspace. */
async function profileOf(personId: string): Promise<string> {
  const person = await tenantClient.person.findFirst({
    where: { id: personId },
    select: { linkedinUrl: true },
  });
  if (person === null) throw new AppError(errors.person_not_found);
  return person.linkedinUrl;
}

function invalidTarget(): never {
  throw new AppError(errors.suppression_target_invalid);
}

/**
 * Writes the entry unless an active one has its key (the migration's suppression_entries_active_key,
 * as INSERT … ON CONFLICT DO NOTHING, so two runs adding it at once keep one row), and reads the
 * active one back; publishes contacts.suppression_added for a new one. An active entry removed
 * between the two statements is written again, WRITE_ATTEMPTS times at most.
 */
async function writeEntry(input: {
  layer: SuppressionLayer;
  target: EntryTarget;
  source: SuppressionSource;
  reason: string | null;
  createdBy: string | null;
}): Promise<AddedEntry> {
  const { workspaceId } = currentTenant();
  const { layer, target, source, reason, createdBy } = input;
  const { matchType, hash, linkedinUrl, domain } = target;
  const row = { id: newId(ids.suppression_entry), workspaceId, layer, matchType, hash };
  const values = { ...row, linkedinUrl, domain, source, reason, createdBy, createdAt: new Date() };
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const { count } = await tenantClient.suppressionEntry.createMany({
      data: [values],
      skipDuplicates: true,
    });
    const entry = await tenantClient.suppressionEntry.findFirst({
      where: { layer, matchType, hash, channel: "all", removedAt: null },
    });
    if (entry === null) continue;
    if (count === 1) {
      const payload = { suppressionId: entry.id, layer };
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
