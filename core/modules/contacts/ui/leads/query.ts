// The list's view in a URL (README.md "Screens"): its status, tier, review and outreach filters, its
// sort and the source it shows the leads of, which the list writes into its own address at each change, a row's link carries to the
// lead page, and the lead page to its neighbours and back to the list. A value off its list is
// dropped, so that a hand-edited address never reaches the api.
import { SOURCE_REF } from "../../domain/constants.ts";
import { OUTREACH_STATUSES, type OutreachStatus } from "../../domain/outreach/constants.ts";

export const STATUSES = [
  "qualified",
  "needs_review",
  "not_qualified",
  "hard_filtered",
  "ai_failed",
  "pending",
] as const;
export const TIERS = ["hot", "warm", "cool"] as const;
export const SORTS = ["fit", "newest", "unreviewed_first"] as const;
const REVIEWS = ["unreviewed"] as const;
export type Status = (typeof STATUSES)[number];
export type Tier = (typeof TIERS)[number];
export type Review = (typeof REVIEWS)[number];
export type Sort = (typeof SORTS)[number];
/** The outreach filter's statuses, in the flow's order. */
export const OUTREACH = OUTREACH_STATUSES;
export type Outreach = OutreachStatus;
export type ListQuery = {
  status?: Status;
  tier?: Tier;
  sort?: Sort;
  review?: Review;
  outreach?: Outreach;
  /** A source's ref, an import job's id or a signal source's: the leads it brought. */
  source?: string;
};

const known = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find((item) => item === value);

/** The view that a page's search parameters name. */
export function readListQuery(search: Record<string, string | string[] | undefined>): ListQuery {
  const { status, tier, sort, review, outreach, source } = search;
  return {
    status: known(STATUSES, status),
    tier: known(TIERS, tier),
    sort: known(SORTS, sort),
    review: known(REVIEWS, review),
    outreach: known(OUTREACH, outreach),
    source: typeof source === "string" && SOURCE_REF.test(source) ? source : undefined,
  };
}

/**
 * `?status=…&tier=…&sort=…&review=…&outreach=…&source=…` of the values given, in that order; ""
 * for none.
 */
export function listQueryString(query: ListQuery): string {
  const { status, tier, sort, review, outreach, source } = query;
  const values = Object.entries({ status, tier, sort, review, outreach, source }).filter(
    ([, value]) => value,
  );
  return values.length === 0 ? "" : `?${new URLSearchParams(values as [string, string][])}`;
}

/**
 * What the list shows: `cursors` are those of the pages after the first, up to the one shown;
 * `status` "" is every status, a source's view with none named.
 */
export type View = {
  status: Status | "";
  tier: Tier | "";
  sort: Sort;
  review: Review | "";
  outreach: Outreach | "";
  source: string;
  cursors: string[];
};

/**
 * The view the search parameters name, on its first page: qualified leads by fit unless named; a
 * source's leads of every status unless a status is named.
 */
export function viewOf(search: Record<string, string | string[] | undefined>): View {
  const named = readListQuery(search);
  const { tier, sort = "fit", review, outreach, source } = named;
  return {
    status: statusOf(named),
    tier: tier ?? "",
    sort,
    review: review ?? "",
    outreach: outreach ?? "",
    source: source ?? "",
    cursors: [],
  };
}

/** The status named, else qualified, else, in a source's view, every status (""). */
export function statusOf({ status, source }: ListQuery): Status | "" {
  return status ?? (source ? "" : "qualified");
}

/** The view's tier, review and outreach filters and its source, none for "all". */
export const filtersOf = ({ tier, review, outreach, source }: View) => ({
  tier: tier || undefined,
  review: review || undefined,
  outreach: outreach || undefined,
  source: source || undefined,
});

/** The view's filters and sort as a query, `?status=…&sort=…`: its address, a row link's query. */
export const queryOf = (view: View) =>
  listQueryString({ status: view.status || undefined, sort: view.sort, ...filtersOf(view) });
