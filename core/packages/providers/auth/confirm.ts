// The confirm step of a sign-in link (README.md "The sign-in link"), the same in every adapter: a mail
// scanner opens the mailed link with a GET, so a GET signs no one in and spends nothing. It answers
// 303 to the confirm page, which carries the link back in `link`; the page's button POSTs to the link
// from the app's own pages, and only that POST signs in.
import type { IncomingMessage } from "node:http";
import { AUTH_LINK_CONFIRM_PATH } from "./port.ts";

/** The answer to a link's GET: the confirm page, with the link's own path and query as `link`. */
export function confirmPage(req: IncomingMessage) {
  const link = encodeURIComponent(req.url ?? "/");
  return { status: 303, headers: { location: `${AUTH_LINK_CONFIRM_PATH}?link=${link}` } };
}

/**
 * Whether a POST comes from the app's own pages: the browser's `Sec-Fetch-Site: same-origin`, or,
 * without that header, an Origin among `origins` or on the request's own Host, when it has one
 * (`Origin: null` never matches). A form on another site that posts someone else's link would sign
 * the visitor in as that person (login CSRF).
 */
export function fromOwnPage(req: IncomingMessage, origins: readonly string[] = []): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin";
  const { origin, host } = req.headers;
  if (origin === undefined) return false;
  return origins.includes(origin) || (host !== undefined && URL.parse(origin)?.host === host);
}
