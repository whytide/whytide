// The Draft's timeouts (README "The website fetch", "The drafter"): the fetch's and the drafter's from
// DRAFT_RUN_MS (domain/constants.ts), which the screens' stuck rule reads too, in milliseconds. Plain
// values: the workflow's sandbox imports them.
import { DRAFT_RUN_MS } from "../domain/constants.ts";

export const DRAFT_TIMEOUTS = {
  /** The fetch: a little above its own sixty-second deadline, so a stalled site fails in one attempt. */
  fetch: DRAFT_RUN_MS.fetch,
  /** The fetch beats once a page. */
  fetchHeartbeat: "30 seconds",
  /**
   * The drafter: one model call on every page and document whole, up to its task's budget of input and
   * of output tokens, thinking included, then the gates' one retry.
   */
  draft: DRAFT_RUN_MS.draft,
  /** A failure's mark, a database write. */
  mark: "10 seconds",
} as const;

/**
 * The pages the website fetch reads first after the home page, in this order (README "The website
 * fetch"): the first link whose path has a word of a group, group by group: about, product, pricing,
 * customers or case studies.
 */
export const FETCH_PREFERRED: readonly (readonly string[])[] = [
  ["about", "about-us", "company", "who-we-are"],
  ["product", "products", "platform", "features", "solutions"],
  ["pricing", "plans", "price"],
  ["customers", "customer-stories", "case-studies", "case-study", "stories", "testimonials"],
];
