// Egress: the rules (alpha-p1-060), which addresses and URLs server code may fetch, decided with no
// network; and the client (alpha-p1-065), fetchSafe, the one way server code fetches a URL, which
// runs them on every hop and connects only to the addresses it checked; and the site reader
// (gamma-en-065), readSite, which reads a company's site through it.

export { isBlockedAddress } from "./address.ts";
export {
  type FetchSafeOptions,
  type FetchSafeResponse,
  fetchSafe,
  type Resolver,
} from "./client.ts";
export { egressConfig, fetchSafeConfig, readEgressConfig, readFetchSafeConfig } from "./config.ts";
export { egressErrors } from "./errors.ts";
export { type HostEntry, matchesHostList, parseHostList } from "./hosts.ts";
export {
  FETCH_LIMITS,
  mailtoOf,
  type PageRead,
  type PreferredPages,
  type ReadPageOptions,
  type ReadSiteOptions,
  type RobotsByHost,
  readPage,
  readSite,
  SITE_CODES,
  type SiteLink,
  type SitePage,
  type SiteRead,
} from "./site/index.ts";
export { allowsBlockedAddress, checkUrl, type EgressLists, isAllowListed } from "./url.ts";
