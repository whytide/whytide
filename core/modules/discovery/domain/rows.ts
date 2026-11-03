// The rows' check (README.md "The report"): each data row's linkedin_url by contacts' profile rule,
// or why it is none, then whether the file had it already; once the file is read, the rows whose
// person was erased. A row's code is a line of the report, never an error of the request. Pure.
import { normalizeLinkedinUrl } from "@whytide/contacts";

export const ROW_CODES = [
  "url_invalid",
  "url_not_linkedin",
  "duplicate_in_file",
  "person_erased",
] as const;
export type RowCode = (typeof ROW_CODES)[number];
export type RowError = { readonly row: number; readonly code: RowCode };
/** A row's check: its profile URL, normalized, or its code. */
export type UrlCheck = { readonly url: string } | { readonly code: RowCode };
/** How many row errors the report keeps, the first ones in row order; the count covers them all. */
export const REPORT_ERRORS = 100;

export type Report = {
  readonly rowCount: number;
  readonly validCount: number;
  readonly errorCount: number;
  readonly errors: readonly RowError[];
};

/**
 * A URL cell: the profile URL as contacts keys a person, or why it is none: url_not_linkedin for an
 * http(s) URL, written with its scheme, of anything else; url_invalid for the rest.
 */
export function checkUrl(cell: string): UrlCheck {
  const url = normalizeLinkedinUrl(cell);
  if (url !== null) return { url };
  const parsed = URL.parse(cell.trim());
  const web = parsed?.protocol === "https:" || parsed?.protocol === "http:";
  return { code: web ? "url_not_linkedin" : "url_invalid" };
}

/** The check of one file's rows, fed in file order. */
export class RowCheck {
  readonly #errors: RowError[] = [];
  /** The first row of each valid URL, normalized. */
  readonly #valid = new Map<string, number>();
  #rows = 0;

  /** Checks the row; its profile URL, or its code, for the import's run. */
  add(row: number, cell: string): UrlCheck {
    this.#rows += 1;
    const url = checkUrl(cell);
    const checked: UrlCheck =
      "url" in url && this.#valid.has(url.url) ? { code: "duplicate_in_file" } : url;
    if ("code" in checked) this.#errors.push({ row, code: checked.code });
    else this.#valid.set(checked.url, row);
    return checked;
  }

  /** The valid rows' URLs, normalized, one each: what the erased-hash check takes. */
  urls(): string[] {
    return [...this.#valid.keys()];
  }

  /** The counts and the first errors, the rows whose URL is in `erased` now person_erased. */
  report(erased: ReadonlySet<string> = new Set()): Report {
    const gone = [...this.#valid]
      .filter(([url]) => erased.has(url))
      .map(([, row]): RowError => ({ row, code: "person_erased" }));
    const errors = [...this.#errors, ...gone].sort((a, b) => a.row - b.row);
    return {
      rowCount: this.#rows,
      validCount: this.#valid.size - gone.length,
      errorCount: errors.length,
      errors: errors.slice(0, REPORT_ERRORS),
    };
  }
}
