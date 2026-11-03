// The leads CSV (README.md "Routes"), in the caller's tenant run: the lead list's columns for every
// lead of the view, by descending fit as the list, read and written a hundred leads at a time. The
// codes are written as the api answers them; the why bullets and a Not a fit's reason are worded in
// English by the platform's messages, from the keys the lead holds, so no module is imported.
import { createTranslator, loadMessages, type Translator } from "@whytide/platform";
import { fields, type PiiClass } from "../fields.ts";
import type { QualificationStatus, Tier } from "../lead.ts";
import { type LeadWithPerson, listLeads } from "../leads.ts";
import { type LatestReview, latestOf } from "../review/reviews.ts";
import type { ReviewFilter } from "../review/rules.ts";
import { csvLine } from "./csv.ts";

/** The view the lead list shows: its filters; the order is the list's by fit. */
export type LeadsView = { status?: QualificationStatus; tier?: Tier; review?: ReviewFilter };
type Row = { readonly lead: LeadWithPerson; readonly review: LatestReview | undefined };
type Table = keyof typeof fields;
/** A column of contacts' tables, `table.column`, as fields.ts classes it. */
type Field = { [T in Table]: `${T}.${keyof (typeof fields)[T] & string}` }[Table];
type Column = {
  readonly header: string;
  /** What the cell is made of: the PII registry decides whether the column may leave. */
  readonly reads: readonly Field[];
  readonly cell: (row: Row, t: Translator) => string | number | null;
};

const BOM = "﻿";
const PAGE = 100;

const person = (column: keyof LeadWithPerson["person"]) => (row: Row) =>
  row.lead.person[column] as string | null;
const ALL: readonly Column[] = [
  { header: "first_name", reads: ["persons.first_name"], cell: person("firstName") },
  { header: "last_name", reads: ["persons.last_name"], cell: person("lastName") },
  { header: "headline", reads: ["persons.headline"], cell: person("headline") },
  { header: "title", reads: ["persons.title"], cell: person("title") },
  { header: "company", reads: ["persons.company_name"], cell: person("companyName") },
  { header: "location", reads: ["persons.location_text"], cell: person("locationText") },
  { header: "fit", reads: ["leads.fit_score"], cell: ({ lead }) => lead.fitScore },
  { header: "tier", reads: ["leads.tier"], cell: ({ lead }) => lead.tier },
  { header: "confidence", reads: ["leads.fit_confidence"], cell: ({ lead }) => lead.fitConfidence },
  {
    header: "status",
    reads: ["leads.qualification_status"],
    cell: ({ lead }) => lead.qualificationStatus,
  },
  { header: "review", reads: ["leads.review_status"], cell: ({ lead }) => lead.reviewStatus },
  {
    header: "review_reason",
    reads: ["review_decisions.reason_code"],
    // The code's English label, as the review panel words it.
    cell: ({ review }, t) =>
      review?.reasonCode ? t(`contacts.review.code.${review.reasonCode}`) : null,
  },
  {
    header: "review_text",
    reads: ["review_decisions.reason_text", "review_decisions.good_reason_text"],
    cell: ({ review }) => review?.reasonText ?? review?.goodReasonText ?? null,
  },
  { header: "source", reads: ["leads.source_label"], cell: ({ lead }) => lead.sourceLabel },
  {
    header: "why",
    reads: ["leads.why"],
    // One bullet a line; a key the bundle lacks is left out, as the list shows nothing for it.
    cell: ({ lead }, t) =>
      lead.why.flatMap(({ key, params }) => (t.has(key) ? [t(key, params)] : [])).join("\n"),
  },
  { header: "linkedin_url", reads: ["persons.linkedin_url"], cell: person("linkedinUrl") },
];
const classOf = (field: Field): PiiClass => {
  const [table, column] = field.split(".") as [Table, string];
  return (fields[table] as Record<string, PiiClass>)[column] ?? "personal";
};
/** A column that reads a `personal` field never leaves (docs/security.md); alpha's CSV has none. */
export const LEADS_CSV_COLUMNS = ALL.filter(({ reads }) =>
  reads.every((field) => classOf(field) !== "personal"),
);

let english: Translator | undefined;

/**
 * The CSV, a page of leads a chunk, the byte-order mark and the header first. Each page is read in a
 * run of its own (`inRun`), so that no run waits on the client between two pages.
 */
export async function* leadsCsv(
  view: LeadsView,
  inRun: <T>(fn: () => Promise<T>) => Promise<T>,
): AsyncGenerator<string> {
  english ??= createTranslator(loadMessages("en"), "en");
  const t = english;
  yield BOM + csvLine(LEADS_CSV_COLUMNS.map(({ header }) => header));
  let cursor: string | undefined;
  do {
    const { leads, nextCursor, reviews } = await inRun(async () => {
      const page = await listLeads({ ...view, sort: "fit", limit: PAGE, cursor });
      const reviewed = page.leads.filter((lead) => lead.reviewStatus !== null);
      return { ...page, reviews: await latestOf(reviewed.map((lead) => lead.personId)) };
    });
    const rows = leads.map((lead) => ({ lead, review: reviews.get(lead.personId) }));
    yield rows.map((row) => csvLine(LEADS_CSV_COLUMNS.map(({ cell }) => cell(row, t)))).join("");
    cursor = nextCursor ?? undefined;
  } while (cursor !== undefined);
}
