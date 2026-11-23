// The browser port's bounds and forms (README.md "The method"): what crosses the port. Lengths are
// counted as JavaScript counts them, in UTF-16 code units.

/** A URL's longest form: the page asked for, its final URL and each link. */
export const URL_MAX = 2048;
/** The page's visible text, at most. */
export const TEXT_MAX = 50_000;
/** A page's links, at most, and the longest text of one. */
export const LINKS_MAX = 300;
export const LINK_TEXT_MAX = 200;
/** The schemes of a page's final URL, without the colon, as Zod reads them. */
export const PAGE_PROTOCOL = /^https?$/;
/** The schemes of a link: a page's own, and an address to write to; without the colon, as Zod reads them. */
export const LINK_PROTOCOL = /^(?:https?|mailto)$/;
/** The same schemes with their colons, as URL writes them. */
export const LINK_SCHEMES: readonly string[] = ["http:", "https:", "mailto:"];
/** An HTTP status. */
export const STATUS_MIN = 100;
export const STATUS_MAX = 599;
