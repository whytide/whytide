// The answers of the imports routes (README.md "Routes"), from which the api's OpenAPI document is
// built. The upload's body is multipart, read by the route itself: no schema (core/apps/api README
// "OpenAPI and the client").
import { z } from "zod";
import { importCounts, importFailure } from "../domain/import/chunks.ts";
import { JOB_STATUSES } from "../domain/jobs.ts";
import { ROW_CODES } from "../domain/rows.ts";

export const importJobResponse = z.strictObject({
  id: z.string(),
  fileName: z.string(),
  status: z.enum(JOB_STATUSES),
  rowCount: z.int(),
  validCount: z.int(),
  errorCount: z.int(),
  /** The first 100 row errors in row order: the line of the file and the code. */
  errors: z.array(z.strictObject({ row: z.int(), code: z.enum(ROW_CODES) })),
  /** What the run did, every data row in one bucket, as far as it went; null until it starts. */
  counts: importCounts.nullable(),
  /** Where a failed run stopped: the chunk of 500 rows to import, 1 for the first, and the code. */
  failure: importFailure.nullable(),
  /** The user who uploaded the file. */
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  /** When the run was asked for; null before it. */
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ImportJobResponse = z.infer<typeof importJobResponse>;

export const importJobListResponse = z.strictObject({ jobs: z.array(importJobResponse) });
export type ImportJobListResponse = z.infer<typeof importJobListResponse>;

export const importJobParams = z.strictObject({
  job: z.string().regex(/^job_[0-9A-HJKMNP-TV-Z]{26}$/, "an import id"),
});
