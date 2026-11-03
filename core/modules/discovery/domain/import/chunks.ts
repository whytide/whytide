// The run's arithmetic (docs/flows.md "Run"), pure: the rows to import cut into chunks, each chunk
// one transaction and one discovery.people_imported, and the counts, which put every data row of the
// file in one bucket: a person created or updated, a profile already earlier in the file, an erased
// person's profile, or an error (no profile URL, or a row contacts refused).
import { z } from "zod";
import type { RowCode } from "../rows.ts";

/** The most rows a chunk holds, and so the most person ids an event carries. */
export const CHUNK_SIZE = 500;

const count = z.int().nonnegative();
/** What a run did: how many data rows ended in each bucket. */
export const importCounts = z.strictObject({
  created: count,
  updated: count,
  skippedDuplicate: count,
  skippedErased: count,
  errors: count,
});
export type ImportCounts = z.infer<typeof importCounts>;
export type RowOutcome = keyof ImportCounts;
/** Where a failed run stopped: the chunk, 1 for the first, and the error's code. */
export const importFailure = z.strictObject({ chunk: z.int().min(1), code: z.string() });
export type ImportFailure = z.infer<typeof importFailure>;

const NONE: ImportCounts = {
  created: 0,
  updated: 0,
  skippedDuplicate: 0,
  skippedErased: 0,
  errors: 0,
};

/** The items in order, `size` to a chunk, the last one shorter; no chunk for no item. */
export function chunk<T>(items: readonly T[], size = CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("a chunk holds one item or more");
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** The counts once each outcome is added to `counts`: a chunk's to those of the chunks before. */
export function tally(outcomes: Iterable<RowOutcome>, counts: ImportCounts = NONE): ImportCounts {
  const next = { ...counts };
  for (const outcome of outcomes) next[outcome] += 1;
  return next;
}

/** The bucket of a row the check refused: a duplicate and an erased person's are skipped. */
export function outcomeOf(code: RowCode): RowOutcome {
  if (code === "duplicate_in_file") return "skippedDuplicate";
  if (code === "person_erased") return "skippedErased";
  return "errors";
}
