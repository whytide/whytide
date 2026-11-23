// How the company index reaches its tables (gamma-rf-010; docs/security.md "Shared companies"), in
// the caller's tenant run as every command of contacts: companies and group_companies are global to
// the tenant client, which passes them as written, so every query on the group's table carries the
// run's SharingGroup (sharing.ts), never an id a caller names; the raw queries on workspace_companies
// name the run's workspace themselves. app writes both tables and never deletes (the migration).
import { Prisma, tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import type { ProvenanceMap } from "../provenance.ts";
import { type CompanyKey, KEY_COLUMNS, KEY_LOCK } from "./constants.ts";
import type { Layer } from "./layers.ts";
import type { SharingGroup } from "./sharing.ts";

/** The workspace's row as the index reads it: its keys, its own facts and its link. */
export type WorkspaceRow = Layer & {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly companyId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};
export type SharedRow = Layer & { readonly id: string };
type Values = Record<string, unknown>;

/**
 * A key's value locked in the run's schema until the run ends: the link takes it before it looks
 * the key up or makes a company with it. The schema in the name keeps a test file's locks its own.
 */
function lockName(key: CompanyKey, value: string): Prisma.Sql {
  return Prisma.sql`hashtextextended(current_schema()::text || ${`:${KEY_LOCK}:${key}:${value}`}, 0)`;
}

/** The run's workspace's row with the id, locked to the run's end; null when it has none. */
export async function lockRow(id: string): Promise<WorkspaceRow | null> {
  const { workspaceId } = currentTenant();
  const locked = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspace_companies WHERE workspace_id = ${workspaceId} AND id = ${id} FOR UPDATE`;
  if (locked.length === 0) return null;
  return (await tenantClient.workspaceCompany.findFirst({ where: { id } })) as WorkspaceRow | null;
}

/** Sets the row's link once: a row linked already keeps its company. Raw, so updated_at stays. */
export async function setLink(rowId: string, companyId: string): Promise<void> {
  const { workspaceId } = currentTenant();
  await tenantClient.$executeRaw`
    UPDATE workspace_companies SET company_id = ${companyId}
    WHERE workspace_id = ${workspaceId} AND id = ${rowId} AND company_id IS NULL`;
}

/** Waits for the key's lock (the link's). */
export async function lockKey(key: CompanyKey, value: string): Promise<void> {
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(${lockName(key, value)})`;
}

/** Takes the key's lock if no other run holds it, without waiting (an offer's); whether it did. */
export async function tryKey(key: CompanyKey, value: string): Promise<boolean> {
  const [row] = await tenantClient.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${lockName(key, value)}) AS locked`;
  return row?.locked === true;
}

/** The id of the shared company with the key's value, or null. */
export async function sharedWith(key: CompanyKey, value: string): Promise<string | null> {
  const where = key === "linkedinUrl" ? { linkedinUrl: value } : { domain: value };
  const found = await tenantClient.sharedCompany.findUnique({ where, select: { id: true } });
  return found?.id ?? null;
}

/** Whether a shared company other than `companyId` holds the key's value. */
export async function sharedElsewhere(
  key: CompanyKey,
  value: string,
  companyId: string,
): Promise<boolean> {
  const holder = await sharedWith(key, value);
  return holder !== null && holder !== companyId;
}

/**
 * Makes the shared company with that one key and no stamp for it, unless one has it (ON CONFLICT DO
 * NOTHING), then reads it: two runs making it at once leave one row, and both read it.
 */
export async function makeShared(key: CompanyKey, value: string): Promise<string | null> {
  const column = Prisma.raw(`"${KEY_COLUMNS[key]}"`);
  await tenantClient.$executeRaw`
    INSERT INTO companies (id, ${column}, field_provenance, created_at, updated_at)
    VALUES (${newId(ids.company)}, ${value}, '{}'::jsonb, now(), now())
    ON CONFLICT DO NOTHING`;
  return sharedWith(key, value);
}

const LAYER_COLUMNS = Prisma.sql`linkedin_url AS "linkedinUrl", domain, industry,
  size_range AS "sizeRange", country, employee_count AS "employeeCount", description,
  provider_refs AS "providerRefs", field_provenance AS "fieldProvenance"`;

/** The shared company, locked to the run's end: every write to it or to a group's row on it first. */
export async function lockShared(companyId: string): Promise<SharedRow | null> {
  const [row] = await tenantClient.$queryRaw<SharedRow[]>`
    SELECT id, ${LAYER_COLUMNS} FROM companies WHERE id = ${companyId} FOR UPDATE`;
  return row ?? null;
}

/** The shared company, read without a lock. */
export async function readShared(companyId: string): Promise<SharedRow | null> {
  const [row] = await tenantClient.$queryRaw<SharedRow[]>`
    SELECT id, ${LAYER_COLUMNS} FROM companies WHERE id = ${companyId}`;
  return row ?? null;
}

/** The group's row on the shared company, or null before its first write. */
export async function readGroupRow(group: SharingGroup, companyId: string): Promise<Layer | null> {
  const [row] = await tenantClient.$queryRaw<Layer[]>`
    SELECT ${LAYER_COLUMNS} FROM group_companies
    WHERE sharing_group_id = ${group} AND company_id = ${companyId}`;
  return row ?? null;
}

/** The shared company with the values and the provenance; under its lock (lockShared). */
export async function writeShared(
  companyId: string,
  values: Values,
  provenance: ProvenanceMap,
): Promise<void> {
  await tenantClient.sharedCompany.update({
    where: { id: companyId },
    data: { ...values, fieldProvenance: provenance },
  });
}

/** The group's row with the values and the provenance, made at its first write; under lockShared. */
export async function writeGroupRow(
  group: SharingGroup,
  companyId: string,
  values: Values,
  provenance: ProvenanceMap,
): Promise<void> {
  const data = { ...values, fieldProvenance: provenance };
  await tenantClient.groupCompany.upsert({
    where: { sharingGroupId_companyId: { sharingGroupId: group, companyId } },
    create: { ...data, sharingGroupId: group, companyId },
    update: data,
  });
}

/** Whether a company of the run's workspace other than the row holds the key's value. */
export async function rowElsewhere(key: CompanyKey, value: string, rowId: string) {
  const where = key === "linkedinUrl" ? { linkedinUrl: value } : { domain: value };
  const found = await tenantClient.workspaceCompany.findFirst({
    where: { ...where, NOT: { id: rowId } },
    select: { id: true },
  });
  return found !== null;
}

/** The row's keys and provenance as refreshCompany copies them down. */
export async function writeRowKeys(rowId: string, values: Values, provenance: ProvenanceMap) {
  await tenantClient.workspaceCompany.update({
    where: { id: rowId },
    data: { ...values, fieldProvenance: provenance },
  });
}

/** The run's workspace's rows with no link, after `after` in id order, `limit` at most: ids only. */
export async function unlinkedRows(after: string, limit: number): Promise<string[]> {
  const { workspaceId } = currentTenant();
  const rows = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspace_companies
    WHERE workspace_id = ${workspaceId} AND company_id IS NULL AND id > ${after}
    ORDER BY id
    LIMIT ${limit}`;
  return rows.map((row) => row.id);
}
