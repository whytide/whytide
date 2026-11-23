// A sources CSV's check and import (README.md "Importing sources"; sources-csv-import), for the routes,
// which declare whytide:own-runs: the file is read and its rows checked outside any run, since a
// post's short link is resolved by a request (post_engagers), and each database step runs in a run of
// its own on the request's tenant (core/packages/db README "One run at a time"). The import checks
// the file again, records it, then creates each valid row in the file's order through createSource,
// each in its own run, under the create's checks and limits: a row past a limit is created disabled.
// Of the file, only its name and the counts are kept.
import { tenantClient, withTenant } from "@whytide/db";
import { isAppError, newId, type TenantContext } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { givenClient } from "../client.ts";
import { assertSenderAccount, createSource } from "../sources.ts";
import {
  type Checked,
  type CheckedRow,
  checkRows,
  type RowError,
  readRow,
  sourceKey,
} from "./check.ts";
import { FILE_NAME_MAX_CHARS, SOURCE_IMPORTS_LISTED } from "./constants.ts";
import { readSourcesCsv } from "./csv.ts";

/** A file as the routes take it: its name, its bytes and the sender account of every row. */
export type SourceFile = {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly senderAccountId: string;
};
export type SourceImport = {
  readonly id: string;
  readonly workspaceId: string;
  readonly fileName: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly createdCount: number;
  readonly disabledCount: number;
  readonly refusedCount: number;
};
/** An import: its record, and every row not imported, the check's and the creates' refusals. */
export type ImportResult = { readonly sourceImport: SourceImport; readonly errors: RowError[] };

const inRun = <T>(tenant: TenantContext, fn: () => Promise<T>) =>
  withTenant(tenant, fn, { client: givenClient() });

/**
 * The check (POST …/sources/imports/check): the file read, the sender account one of the workspace's
 * (signal_sender_account_invalid) and the caller's own unless signals.manage's (forbidden), each
 * row read in turn, then the repeats; nothing is written.
 */
export async function checkSources(tenant: TenantContext, file: SourceFile): Promise<Checked> {
  const rows = readSourcesCsv(file.name, file.bytes);
  await inRun(tenant, () => assertSenderAccount(file.senderAccountId));
  const read: (CheckedRow | RowError)[] = [];
  // One row at a time: at most one short link's request under way.
  for (const row of rows) read.push(await readRow(row));
  const existing = await inRun(tenant, async () => {
    const select = { kind: true, config: true } as const;
    const sources = await tenantClient.signalSource.findMany({ select });
    return new Set(sources.map(({ kind, config }) => sourceKey(kind, config)));
  });
  return checkRows(read, existing);
}

/**
 * The import (POST …/sources/imports): the check again, the import recorded, each valid row created
 * as its own source of the import, disabled past a limit; a create refused is a row error with its
 * code. Then the record's counts.
 */
export async function importSources(
  tenant: TenantContext,
  file: SourceFile,
): Promise<ImportResult> {
  const checked = await checkSources(tenant, file);
  const record = {
    id: newId(ids.signal_source_import),
    workspaceId: tenant.workspaceId,
    fileName: Array.from(file.name).slice(0, FILE_NAME_MAX_CHARS).join(""),
    createdBy: tenant.principal.userId,
  };
  await inRun(tenant, () => tenantClient.signalSourceImport.create({ data: record }));
  const errors = [...checked.errors];
  let created = 0;
  let disabled = 0;
  for (const { row, kind, config, label } of checked.valid) {
    const input = {
      kind,
      config,
      label,
      senderAccountId: file.senderAccountId,
      importId: record.id,
    };
    try {
      const source = await inRun(tenant, () => createSource(input, "disable"));
      created += 1;
      if (!source.enabled) disabled += 1;
    } catch (error) {
      if (!isAppError(error)) throw error;
      errors.push({ row, code: error.code, columns: [] });
    }
  }
  const counts = { createdCount: created, disabledCount: disabled, refusedCount: errors.length };
  const sourceImport = await inRun(tenant, () =>
    tenantClient.signalSourceImport.update({ where: { id: record.id }, data: counts }),
  );
  return { sourceImport, errors: errors.sort((a, b) => a.row - b.row) };
}

/** The workspace's source imports, the newest first, SOURCE_IMPORTS_LISTED at most. */
export function listSourceImports(): Promise<SourceImport[]> {
  return tenantClient.signalSourceImport.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SOURCE_IMPORTS_LISTED,
  });
}

/** The file name of each import the sources came from, by its id, in the caller's run. */
export async function importFilesOf(
  sources: readonly { readonly importId: string | null }[],
): Promise<Map<string, string>> {
  const named = sources.map(({ importId }) => importId).filter((id) => id !== null);
  if (named.length === 0) return new Map();
  const found = await tenantClient.signalSourceImport.findMany({
    where: { id: { in: [...new Set(named)] } },
    select: { id: true, fileName: true },
  });
  return new Map(found.map(({ id, fileName }) => [id, fileName]));
}
