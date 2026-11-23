// The Companies found screen's constants (README.md "Screen"; gamma-wr-111): the routes it reads and
// writes, who may export, the verdict filter's values, the page's size, the loading state's skeletons,
// the source types a row names (the ids of domain/research/places/, whose labels are `signals.places.*`)
// and the addresses of the screen with a source or an agent chosen, which the sources' card and the
// agent's panel link to.
import type { Verdict } from "../../domain/research/constants.ts";

export const FOUND_PATH = "/v1/workspaces/{workspaceId}/signals/found-companies" as const;
export const FOUND_EXPORT_PATH =
  "/v1/workspaces/{workspaceId}/signals/found-companies/export.csv" as const;
export const NOT_FIT_PATH =
  "/v1/workspaces/{workspaceId}/signals/found-companies/{id}/not-fit" as const;

/** The roles that hold `exports.read` (contacts' permissions): the Download CSV button is theirs. */
export const FOUND_EXPORT_ROLES = ["Owner", "Admin"] as const;

/** No filter chosen: the verdict's default (fit and unsure), every source, every agent. */
export const ANY = "";
/** The verdict filter's values, in its select's order. */
export const VERDICT_FILTERS = [ANY, "fit", "unsure", "not_fit"] as const satisfies readonly (
  | ""
  | Verdict
)[];
export type VerdictFilter = (typeof VERDICT_FILTERS)[number];

/** The companies one read asks for, the screen's page. */
export const FOUND_PAGE_SIZE = 25;
/** The loading state's skeleton cards, and their lines. */
export const SKELETON = { cards: 3, lines: 4 } as const;
/** The leads a card names before it says how many more. */
export const LEADS_SHOWN = 5;

/** The source types a row names: `placeId`, whose label is the key `signals.places.<id>.label`. */
export const SOURCE_TYPES = [
  "association_members",
  "contracts_awarded",
  "customer_sites",
  "dealer_lists",
  "distributor_lists",
  "fair_exhibitors",
  "public_tenders",
  "supplier_registries",
  "web_search",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The screen's segment, as ui/nav.ts names it. */
export const FOUND_SEGMENT = "companies-found";

/** The screen, with a source or an agent chosen, a verdict too: the address the links go to. */
export const foundScreen = (
  workspaceId: string,
  chosen: { source?: string; agent?: string; verdict?: string } = {},
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(chosen)) if (value) query.set(key, value);
  const text = query.toString();
  return `/w/${workspaceId}/${FOUND_SEGMENT}${text ? `?${text}` : ""}`;
};
