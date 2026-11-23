// The exclusion lists' commands (gamma-p2-045; README.md "Exclusion lists"; docs/flows.md), inside
// the caller's tenant run like every command of contacts: a file's domains imported as one list, all
// or nothing; the lists as the route reads them; a list removed as a whole. An import writes
// relationship entries on every channel, source csv, each with the list's id, IMPORT_CHUNK at a time
// by INSERT … ON CONFLICT DO NOTHING on the active key, so that a domain an active relationship entry
// holds is a duplicate, whatever its kind, as an add by hand answers that entry (entries.ts). Each
// chunk then moves the leads its domains hold to `suppressed` (affected.ts). One
// contacts.suppression_added per import, with the list's id, and none when it added nothing:
// campaigns' subscriber reads the suppressed enrollments again in batches. No list is ever deleted.
// review-gaps: each chunk also records every domain the list names, its duplicates included, in
// exclusion_list_domains, so a removal moves each of the list's active entries whose domain another
// active list names under that list, and removes only the rest. An import and a removal of one
// workspace take its advisory lock first (EXCLUSIONS_LOCK), so neither reads the lists while the
// other's run is uncommitted; a hand add's takeover of an entry (entries.ts) is one conditional
// update of the entry's row, which serializes with the removal's on that row.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { id as idRule, listInput, parseInput, requireId } from "../rules.ts";
import { suppressLeadsAtDomains } from "../suppression/affected.ts";
import {
  EVERY_CHANNEL,
  SUPPRESSION_RELATIONSHIPS,
  type SuppressionRelationship,
} from "../suppression/constants.ts";
import { domainTarget } from "../suppression/matching.ts";
import { EXCLUSIONS_LOCK, IMPORT_CHUNK, LIST_NAME_MAX, ROWS_SHOWN } from "./constants.ts";
import type { DomainRow, ExclusionFile, RowError } from "./rows.ts";

export type ExclusionList = {
  readonly id: string;
  /** The uploaded file's name, its first LIST_NAME_MAX characters. */
  readonly name: string;
  readonly relationship: SuppressionRelationship;
  readonly entryCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
  /** The user who imported the file. */
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly removedAt: Date | null;
  readonly removedBy: string | null;
};
/** An import's answer: the list, its counts, and the first ROWS_SHOWN rows without an entry. */
export type ImportAnswer = {
  readonly list: ExclusionList;
  readonly added: number;
  readonly duplicates: number;
  /** domain_invalid and duplicate rows, by record number. */
  readonly invalid: readonly RowError[];
};

const importInput = z.strictObject({
  name: z.string().min(1),
  relationship: z.enum(SUPPRESSION_RELATIONSHIPS),
  createdBy: idRule,
});
const LIST_COLUMNS = {
  id: true,
  name: true,
  relationship: true,
  entryCount: true,
  duplicateCount: true,
  invalidCount: true,
  createdBy: true,
  createdAt: true,
  removedAt: true,
  removedBy: true,
} as const;

/**
 * Imports the file's domains as one list of `relationship` entries on every channel, by the user
 * `createdBy`, named after the file. The domains of a file are new entries, or duplicates when an
 * active relationship entry holds them already; the leads of the persons at each domain or a
 * subdomain become `suppressed`. exclusions_no_valid_row for a file without a domain: no list is
 * made. contacts_input_invalid naming the fields for an empty name, a relationship off the list or
 * no user.
 */
export async function importExclusionList(input: {
  name: string;
  relationship: SuppressionRelationship;
  createdBy: string;
  file: ExclusionFile;
}): Promise<ImportAnswer> {
  const { name, relationship, createdBy } = parseInput(importInput, {
    name: input.name,
    relationship: input.relationship,
    createdBy: input.createdBy,
  });
  const { domains, rejected } = input.file;
  if (domains.length === 0) throw new AppError(errors.exclusions_no_valid_row);
  const { workspaceId } = currentTenant();
  await lockExclusions(workspaceId);
  const list = {
    id: newId(ids.exclusion_list),
    workspaceId,
    name: Array.from(name).slice(0, LIST_NAME_MAX).join(""),
    relationship,
    createdBy,
    createdAt: new Date(),
  };
  const invalidCount = rejected.filter(({ code }) => code === "domain_invalid").length;
  await tenantClient.exclusionList.create({
    data: { ...list, entryCount: 0, duplicateCount: 0, invalidCount },
    select: { id: true },
  });
  const held: RowError[] = [];
  let first: string | undefined;
  let added = 0;
  for (let start = 0; start < domains.length; start += IMPORT_CHUNK) {
    const chunk = domains.slice(start, start + IMPORT_CHUNK);
    const written = await writeChunk(chunk, list);
    first ??= written.ids[0];
    added += written.ids.length;
    held.push(...written.held);
    await suppressLeadsAtDomains(
      chunk.map(({ domain }) => domain),
      createdBy,
    );
  }
  const duplicates = rejected.length - invalidCount + held.length;
  const stored = await tenantClient.exclusionList.update({
    where: { id: list.id },
    data: { entryCount: added, duplicateCount: duplicates },
    select: LIST_COLUMNS,
  });
  if (first !== undefined) {
    const payload = {
      suppressionId: first,
      layer: "relationship",
      channel: EVERY_CHANNEL,
    } as const;
    const event = events["contacts.suppression_added"];
    await publish(outboxWriter(tenantClient, workspaceId), event, { ...payload, listId: list.id });
  }
  const invalid = [...rejected, ...held].sort((a, b) => a.row - b.row).slice(0, ROWS_SHOWN);
  return { list: stored as ExclusionList, added, duplicates, invalid };
}

/**
 * A page of the workspace's lists, newest first, removed ones included, `limit` of them after the
 * `cursor`, the last id of the page before; `nextCursor` is null on the last page.
 */
export async function listExclusionLists(input: {
  limit: number;
  cursor?: string;
}): Promise<{ lists: ExclusionList[]; nextCursor: string | null }> {
  const { limit, cursor } = parseInput(listInput, input);
  const rows = await tenantClient.exclusionList.findMany({
    where: cursor === undefined ? {} : { id: { lt: cursor } },
    orderBy: { id: "desc" },
    take: limit + 1,
    select: LIST_COLUMNS,
  });
  const lists = rows.slice(0, limit) as ExclusionList[];
  const nextCursor = rows.length > limit ? (lists.at(-1)?.id ?? null) : null;
  return { lists, nextCursor };
}

/**
 * Removes a list as a whole, under the workspace's lock: sets removed_at and removed_by on it; moves
 * each of its active entries whose domain another active list names under that list, the earliest
 * created, with that list's relationship (no event: its leads are suppressed already); then sets
 * removed_at and removed_by on the rest, as removeSuppression lifts one (entries.ts), the rows kept.
 * An entry removed by hand before stays as it was, and one a person took over (entries.ts) is no
 * list's; the leads stay `suppressed` until Approve. exclusion_list_not_found for an id of no list of
 * the workspace, or of one removed already.
 */
export async function removeExclusionList(
  listId: string,
  input: { removedBy: string },
): Promise<void> {
  const id = requireId("listId", listId);
  const removedBy = requireId("removedBy", input?.removedBy);
  const { workspaceId } = currentTenant();
  await lockExclusions(workspaceId);
  const removedAt = new Date();
  const { count } = await tenantClient.exclusionList.updateMany({
    where: { id, removedAt: null },
    data: { removedAt, removedBy },
  });
  if (count === 0) throw new AppError(errors.exclusion_list_not_found);
  await moveHeldEntries(workspaceId, id);
  await tenantClient.suppressionEntry.updateMany({
    where: { exclusionListId: id, removedAt: null },
    data: { removedAt, removedBy },
  });
}

/**
 * The workspace's lock of its exclusion lists, until the caller's run ends (the file's header): an
 * import's and a removal's first statement, waited for.
 */
async function lockExclusions(workspaceId: string): Promise<void> {
  const key = `${EXCLUSIONS_LOCK}:${workspaceId}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * One statement: each active entry of the removed list whose hash another active list names in
 * exclusion_list_domains goes to the earliest created of those lists, ties by id, taking its
 * relationship. The removed list is marked first, so it names nothing here.
 */
async function moveHeldEntries(workspaceId: string, listId: string): Promise<void> {
  await tenantClient.$executeRaw`
    UPDATE suppression_entries AS e
    SET exclusion_list_id = held.list_id, relationship = held.relationship
    FROM (
      SELECT DISTINCT ON (d.hash) d.hash, l.id AS list_id, l.relationship
      FROM exclusion_list_domains AS d
      JOIN exclusion_lists AS l ON l.workspace_id = d.workspace_id AND l.id = d.exclusion_list_id
      WHERE d.workspace_id = ${workspaceId} AND l.removed_at IS NULL
        AND d.hash IN (
          SELECT s.hash FROM suppression_entries AS s
          WHERE s.workspace_id = ${workspaceId} AND s.exclusion_list_id = ${listId}
            AND s.removed_at IS NULL
        )
      ORDER BY d.hash, l.created_at, l.id
    ) AS held
    WHERE e.workspace_id = ${workspaceId} AND e.exclusion_list_id = ${listId}
      AND e.removed_at IS NULL AND e.hash = held.hash`;
}

/**
 * One statement for the chunk's domains, every one the list names (exclusion_list_domains), then one
 * for its entries, INSERT … ON CONFLICT DO NOTHING on the active key: the ids of the entries it
 * wrote, oldest first, and the rows whose domain an active entry held already.
 */
async function writeChunk(
  chunk: readonly DomainRow[],
  list: {
    readonly id: string;
    readonly workspaceId: string;
    readonly relationship: SuppressionRelationship;
    readonly createdBy: string;
    readonly createdAt: Date;
  },
): Promise<{ ids: string[]; held: RowError[] }> {
  const { id: exclusionListId, workspaceId, relationship, createdBy, createdAt } = list;
  const hashed = chunk.map(({ domain }) => ({ domain, hash: domainTarget(domain).hash }));
  await tenantClient.exclusionListDomain.createMany({
    data: hashed.map(({ hash }) => ({ workspaceId, exclusionListId, hash })),
    skipDuplicates: true,
  });
  const data = hashed.map(({ domain, hash }) => {
    const id = newId(ids.suppression_entry);
    const key = { id, workspaceId, layer: "relationship", matchType: "domain", hash } as const;
    const values = { channel: EVERY_CHANNEL, relationship, domain, source: "csv" } as const;
    return { ...key, ...values, createdBy, createdAt, exclusionListId };
  });
  const written = await tenantClient.suppressionEntry.createManyAndReturn({
    data,
    skipDuplicates: true,
    select: { id: true, domain: true },
  });
  const domains = new Set(written.map(({ domain }) => domain));
  const held = chunk
    .filter(({ domain }) => !domains.has(domain))
    .map(({ row }): RowError => ({ row, code: "duplicate" }));
  return { ids: written.map(({ id }) => id).sort(), held };
}
