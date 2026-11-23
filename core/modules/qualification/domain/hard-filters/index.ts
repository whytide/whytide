// The hard filters (docs/concepts.md): before any model sees a person, pure code decides whether the
// country and the company size can match the ICP at all, and says why not. The title is the
// assessment's (title-check-ai): titles.ts stays for signals' read order only. Balanced mode only: an
// unknown value passes to the assessment, a known mismatch fails. Nothing is imported from outside
// this folder: the inputs are structural types that contacts' and icp's records satisfy as they are
// (tests/hard-filters.test.ts proves it), so the signal run and the batch pass them in. A caller with
// many persons prepares the filters for its ICP once (prepareHardFilters).
import { type SizeRange, sizeRangesOf } from "./size.ts";

/**
 * Why a person failed, a closed list: the lead's hard_filter_reason (alpha-p6-040). title_mismatch
 * names older rows only: no filter gives it since title-check-ai.
 */
export const HARD_FILTER_REASONS = ["title_mismatch", "country_mismatch", "size_mismatch"] as const;
export type HardFilterReason = (typeof HARD_FILTER_REASONS)[number];
/** The reasons no filter gives anymore: the batch assesses such a lead again (README "The batch"). */
export const RETIRED_HARD_FILTER_REASONS = [
  "title_mismatch",
] as const satisfies readonly HardFilterReason[];

/** What the filters read of a person; contacts' Person satisfies it. */
export type HardFilterPerson = {
  /** ISO 3166-1 alpha-2. */
  readonly locationCountry?: string | null;
};
/** What the filters read of the person's company; contacts' WorkspaceCompany satisfies it. */
export type HardFilterCompany = {
  /** Free text, as the source wrote it (`11-50 employees`). */
  readonly sizeRange?: string | null;
};
/** The ICP's targeting the filters compare with; icp's Icp satisfies it. An empty list filters nothing. */
export type HardFilterIcp = {
  /** ISO 3166-1 alpha-2. */
  readonly countries: readonly string[];
  readonly sizeRanges: readonly SizeRange[];
};
/**
 * The values compared, for the lead page: the person's or company's value, trimmed (a country in
 * upper case), and the ICP's list as it holds it.
 */
export type HardFilterDetail = { readonly value: string; readonly icp: readonly string[] };
export type HardFilterResult =
  | { readonly passed: true }
  | {
      readonly passed: false;
      readonly reason: HardFilterReason;
      readonly detail: HardFilterDetail;
    };

/** The filters for one ICP: what applyHardFilters answers, for a person and the person's company. */
export type PreparedHardFilters = (
  person: HardFilterPerson,
  company: HardFilterCompany | null,
) => HardFilterResult;

/**
 * The two filters in the order country, company size; the first miss is the result. A value the
 * person or the company lacks (no country, no company, a size that reads as no count) passes, and so
 * does a list the ICP leaves empty; any title passes. It prepares the ICP on every call: a caller with
 * many persons prepares once (prepareHardFilters).
 */
export function applyHardFilters(
  person: HardFilterPerson,
  company: HardFilterCompany | null,
  icp: HardFilterIcp,
): HardFilterResult {
  return prepareHardFilters(icp)(person, company);
}

/**
 * The filters for one ICP, its countries and sizes read once: the signal run and the batch prepare
 * once per run or batch and keep the function, which holds a copy of what it read and nothing else.
 */
export function prepareHardFilters(icp: HardFilterIcp): PreparedHardFilters {
  const countries = [...icp.countries];
  const codes = countries.map((code) => code.toUpperCase());
  const sizes = [...icp.sizeRanges];
  return (person, company) => {
    const country = person.locationCountry?.trim().toUpperCase() ?? "";
    if (country !== "" && codes.length > 0 && !codes.includes(country)) {
      return miss("country_mismatch", country, countries);
    }
    const size = company?.sizeRange?.trim() ?? "";
    const ranges = sizeRangesOf(size);
    if (ranges !== null && sizes.length > 0 && !ranges.some((range) => sizes.includes(range))) {
      return miss("size_mismatch", size, sizes);
    }
    return { passed: true };
  };
}

function miss(reason: HardFilterReason, value: string, icp: readonly string[]): HardFilterResult {
  return { passed: false, reason, detail: { value, icp: [...icp] } };
}
