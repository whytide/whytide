// The fake's fixed values (../README.md "The fake").

/** The schemes a seeded page's URL may have. */
export const SEEDED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
/** A seeded page's status when the seed gives none. */
export const SEEDED_STATUS = 200;
/** browser_blocked's `details.reason` for a URL nothing was seeded under. */
export const NOT_SEEDED = "not_seeded";
