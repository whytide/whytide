// The Companies found CSV (README.md "Web research"; gamma-wr-110): the list's view as a file, a page of
// companies a chunk, the byte-order mark and the header first, each cell written by contacts' CSV writer
// (`csvLine`, public), so that a cell a spreadsheet would run as a formula is neutralized as every CSV we
// write is (docs/rules/security.md §2). It holds the company's own facts only: no lead's address or phone.
// Each page is read in a run of its own (`inRun`), so that no run waits on a client that reads slowly.
import { csvLine } from "@whytide/contacts";
import { FOUND_CSV_PAGE } from "./constants.ts";
import { type FoundCompany, type FoundFilter, listFoundCompanies } from "./found-list.ts";

const BOM = "﻿";
const PHONES_JOINER = "; ";
const LEADS_JOINER = "\n";

/** A column of the file: its header and the cell of a company. */
type Column = {
  readonly header: string;
  readonly cell: (company: FoundCompany) => string | number | null;
};

/** One reason a line, as a member reads it on the page: what it shows, its quote and its page. */
const reasonLine = ({ kind, answer, line, quote, url }: FoundCompany["reasons"][number]): string =>
  `${kind} (${answer}): ${line} "${quote}" ${url}`;

/** One lead a line: the name and the title, never an address or a phone number. */
const leadLine = ({ name, title }: FoundCompany["leads"][number]): string =>
  [name, title].filter((part) => part !== null).join(", ");

export const FOUND_CSV_COLUMNS: readonly Column[] = [
  { header: "company", cell: ({ name }) => name },
  { header: "website", cell: ({ website }) => website },
  { header: "verdict", cell: ({ verdict }) => verdict },
  { header: "set_by_member", cell: ({ markedByMember }) => (markedByMember ? "yes" : "no") },
  { header: "country", cell: ({ country }) => country },
  { header: "town", cell: ({ town }) => town },
  { header: "state", cell: ({ state }) => state },
  { header: "reasons", cell: ({ reasons }) => reasons.map(reasonLine).join("\n") },
  { header: "found_on_page", cell: ({ pageUrl }) => pageUrl },
  { header: "source_type", cell: ({ placeId }) => placeId },
  { header: "source", cell: ({ sourceLabel }) => sourceLabel },
  { header: "email", cell: ({ email }) => email },
  { header: "phones", cell: ({ phones }) => phones.join(PHONES_JOINER) },
  { header: "postal_address", cell: ({ postalAddress }) => postalAddress },
  { header: "leads_found", cell: ({ leadCount }) => leadCount },
  { header: "leads", cell: ({ leads }) => leads.map(leadLine).join(LEADS_JOINER) },
  { header: "judged_at", cell: ({ judgedAt }) => judgedAt.toISOString() },
];

/** The CSV of the view the filter names, newest first as the list. */
export async function* foundCompaniesCsv(
  filter: FoundFilter,
  inRun: <T>(fn: () => Promise<T>) => Promise<T>,
): AsyncGenerator<string> {
  yield BOM + csvLine(FOUND_CSV_COLUMNS.map(({ header }) => header));
  let cursor: string | undefined;
  do {
    const page = await inRun(() => listFoundCompanies(filter, { limit: FOUND_CSV_PAGE, cursor }));
    yield page.companies
      .map((company) => csvLine(FOUND_CSV_COLUMNS.map(({ cell }) => cell(company))))
      .join("");
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}
