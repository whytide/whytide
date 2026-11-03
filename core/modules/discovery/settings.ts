// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8): the
// limits of an uploaded CSV (README.md "POST …/imports").
import { defineConfig } from "@whytide/platform";
import { FILE_MAX_BYTES } from "@whytide/providers";
import { z } from "zod";
import { IMPORT_MAX_BYTES_DEFAULT } from "./domain/limits.ts";

export const settings = defineConfig("modules/discovery", {
  /**
   * Data rows a file may hold, the header aside; the next one stops the reading. At most 50,000, as
   * the erased check sends a file's URLs in one query, under Postgres' 65,535 parameters.
   */
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(50_000).default(5_000),
  /** Bytes a file may hold, at most what the files port holds in memory (25 MiB). */
  IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(FILE_MAX_BYTES)
    .default(IMPORT_MAX_BYTES_DEFAULT),
});
