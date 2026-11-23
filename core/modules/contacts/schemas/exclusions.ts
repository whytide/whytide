// The requests and answers of contacts' exclusion list routes (gamma-p2-045; README.md "Routes"), from
// which the api builds its OpenAPI document: the import's query and answer, a list, the lists' page
// and a list's id. The file itself is the multipart body, which the route reads (api/multipart.ts).
// Never a cell of the file: a row is its record number and its code.
import { z } from "zod";
import { ROW_CODES } from "../domain/exclusions/constants.ts";
import { SUPPRESSION_RELATIONSHIPS } from "../domain/suppression/constants.ts";
import { listQuery } from "./persons.ts";

/** What the file's companies are excluded as. */
export const exclusionImportQuery = z.strictObject({
  relationship: z.enum(SUPPRESSION_RELATIONSHIPS),
});
export type ExclusionImportQuery = z.infer<typeof exclusionImportQuery>;

/** A list: the file's name, its kind, its counts, who imported it and when, and its removal. */
export const exclusionList = z.strictObject({
  id: z.string(),
  name: z.string(),
  relationship: z.enum(SUPPRESSION_RELATIONSHIPS),
  entryCount: z.int(),
  duplicateCount: z.int(),
  invalidCount: z.int(),
  createdBy: z.string(),
  createdAt: z.string(),
  /** Set once an Owner or an Admin removed the list; null while it holds. */
  removedAt: z.string().nullable(),
  removedBy: z.string().nullable(),
});
export type ExclusionListResponse = z.infer<typeof exclusionList>;

/** The import's answer: the list, what it added, and the first rows without an entry. */
export const exclusionImport = z.strictObject({
  list: exclusionList,
  added: z.int(),
  duplicates: z.int(),
  /** domain_invalid and duplicate rows by record number, the header's being 1; 100 at most. */
  invalid: z.array(z.strictObject({ row: z.int(), code: z.enum(ROW_CODES) })),
});
export type ExclusionImportResponse = z.infer<typeof exclusionImport>;

export const exclusionListPage = z.strictObject({
  lists: z.array(exclusionList),
  nextCursor: z.string().nullable(),
});
export type ExclusionListPage = z.infer<typeof exclusionListPage>;

/** The page's size, 1 to 100 (50), and the `nextCursor` of the page before: the persons'. */
export const exclusionListQuery = listQuery;
export type ExclusionListQuery = z.infer<typeof exclusionListQuery>;

/** A list's id. */
export const exclusionListParams = z.strictObject({ listId: z.string().min(1).max(64) });
