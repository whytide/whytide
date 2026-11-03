// POST …/imports (README.md): the upload, outside the request's tenant run (whytide:own-runs), since
// it reads the client's stream and calls the files port. The file is read and checked as it arrives,
// its valid URLs are looked up in contacts' erased hashes in a run of its own, the file is stored
// under the workspace's imports/ folder, and the job is written with the report in a second run,
// each run on the request's tenant (docs/flows.md).
import type { IncomingMessage } from "node:http";
import { isHashed } from "@whytide/contacts";
import { AppError, isAppError, newId, type TenantContext } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { readCsv } from "../domain/csv.ts";
import { createImportJob, type ImportJob } from "../domain/jobs.ts";
import { RowCheck } from "../domain/rows.ts";
import { inRun } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { settings } from "../settings.ts";
import { receiveFile } from "./multipart.ts";

/** The body a request may carry: twice the file's limit, so a file a little over it is told so. */
export const BODY_LIMIT = 2 * settings.IMPORT_MAX_BYTES;
/** The stored file name's length at most: a longer one keeps its first characters. */
const NAME_MAX = 255;

export async function uploadImport(
  req: IncomingMessage,
  tenant: TenantContext,
): Promise<ImportJob> {
  const id = newId(ids.import_job);
  const rows = new RowCheck();
  const limits = { maxBytes: settings.IMPORT_MAX_BYTES, maxRows: settings.IMPORT_MAX_ROWS };
  const upload = { fileBytes: limits.maxBytes, bodyBytes: BODY_LIMIT };
  const { name, bytes } = await receiveFile(req, upload, async ({ name, stream }) => ({
    name,
    bytes: await readCsv(stream, limits, ({ row, linkedinUrl }) => rows.add(row, linkedinUrl)),
  }));
  const erased = await erasedOf(rows.urls(), tenant);
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const stored = await files
    .put({
      workspaceId: tenant.workspaceId,
      key: `imports/${id}.csv`,
      body: bytes,
      contentType: "text/csv; charset=utf-8",
      maxBytes: settings.IMPORT_MAX_BYTES,
    })
    .catch((error: unknown) => {
      const tooLarge = isAppError(error) && error.code === filesPort.errors.files_too_large;
      throw tooLarge ? new AppError(errors.import_too_large) : error;
    });
  const job = {
    id,
    workspaceId: tenant.workspaceId,
    fileKey: stored.key,
    fileName: Array.from(name).slice(0, NAME_MAX).join(""),
    createdBy: tenant.principal.userId,
    report: rows.report(erased),
  };
  return inRun(tenant, (tx) => createImportJob(tx, job));
}

/**
 * The valid URLs whose person was erased from the workspace: contacts' isHashed, once per file,
 * before the file is stored. A rejected candidate's hash marks no row.
 */
async function erasedOf(urls: readonly string[], tenant: TenantContext): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const hashed = await inRun(tenant, () => isHashed({ linkedinUrls: urls }));
  return new Set([...hashed].filter(([, kind]) => kind === "erased").map(([url]) => url));
}
