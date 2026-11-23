// The site reader (README "The site reader"): a company's site read within fixed bounds, robots.txt
// first, every request through fetchSafe; onboarding's Draft and enrichment's `website` source use it.

export { FETCH_LIMITS, SITE_CODES } from "./constants.ts";
export { mailtoOf, type PreferredPages } from "./links.ts";
export {
  type PageRead,
  type ReadPageOptions,
  type ReadSiteOptions,
  type RobotsByHost,
  readPage,
  readSite,
  type SiteLink,
  type SitePage,
  type SiteRead,
} from "./read.ts";
