// An exclusion file's rows (README.md "Exclusion lists"; docs/security.md "Exclusion lists"): the
// `domain` column's cell of each data row is a domain as contacts normalizes a company's, or the row
// is domain_invalid; a domain the file had already is a duplicate. A cell is never evaluated and,
// past its domain, never kept: a row is answered by its record number and its code. Pure.
import { companyDomain } from "../suppression/matching.ts";
import {
  FORMULA_PREFIXES,
  NOT_IN_A_DOMAIN,
  type RowCode,
  TRAILING_SLASH,
  WEB_SCHEME,
} from "./constants.ts";

/** A row without an entry: its record number in the file, the header's being 1, and why. */
export type RowError = { readonly row: number; readonly code: RowCode };
/** A data row with a domain: its record number and the domain, normalized. */
export type DomainRow = { readonly row: number; readonly domain: string };
/** A file as read: each domain's first row, in file order, and the rows that have none or repeat one. */
export type ExclusionFile = {
  readonly domains: readonly DomainRow[];
  /** domain_invalid, and duplicate for a domain an earlier row had, in record order. */
  readonly rejected: readonly RowError[];
};

/**
 * A cell's domain: lowercased, without an http(s) scheme, `www.` or a trailing slash, of two labels
 * or more and never LinkedIn's (matching.ts companyDomain); null for anything else, an empty cell, a
 * formula (a cell starting with =, +, - or @), an email, credentials, a port, a path, a query, a
 * fragment, a percent escape, a space or a control character among them.
 */
export function domainOfCell(cell: string): string | null {
  const text = cell.trim();
  if (text === "" || FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  const host = text.replace(WEB_SCHEME, "").replace(TRAILING_SLASH, "");
  if (NOT_IN_A_DOMAIN.test(host) || host.includes("/")) return null;
  return companyDomain(host);
}

/** The check of one file's rows, fed in file order. */
export class ExclusionRows {
  /** The first row of each domain, in file order. */
  readonly #domains = new Map<string, number>();
  readonly #rejected: RowError[] = [];

  /** Checks a data row's cell: its domain, else domain_invalid, else duplicate for one seen before. */
  add(row: number, cell: string): void {
    const domain = domainOfCell(cell);
    if (domain === null) this.#rejected.push({ row, code: "domain_invalid" });
    else if (this.#domains.has(domain)) this.#rejected.push({ row, code: "duplicate" });
    else this.#domains.set(domain, row);
  }

  file(): ExclusionFile {
    const domains = [...this.#domains].map(([domain, row]) => ({ row, domain }));
    return { domains, rejected: [...this.#rejected] };
  }
}
