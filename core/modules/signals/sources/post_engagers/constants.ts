// The post_engagers kind's constants (README.md "Kinds"): the short link LinkedIn's Share button
// gives, and the one request a create sends it (post-url.ts).
import type { FetchSafeOptions } from "@whytide/platform";

/** The host of LinkedIn's short links. */
export const SHORT_LINK_HOST = "lnkd.in";

/** A short link's path: /p/<code> or /<code>. */
export const SHORT_LINK_PATH = /^\/(?:p\/)?[A-Za-z0-9_-]{1,64}$/;

/**
 * The request: its redirect answered unfollowed (fetchSafe's returnRedirect), a kilobyte of a body
 * that is never read, five seconds in all.
 */
export const SHORT_LINK_REQUEST: FetchSafeOptions = {
  maxRedirects: 0,
  returnRedirect: true,
  maxBytes: 1_024,
  truncate: true,
  timeoutMs: 5_000,
};

/** The statuses that redirect, as fetchSafe has them. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
