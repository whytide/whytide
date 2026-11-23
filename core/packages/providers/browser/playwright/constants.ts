// The playwright adapter's bounds and fixed values (README.md "The limits", "The fences", "The route filter").
import type { BrowserContextOptions } from "playwright-core";
import { LINK_SCHEMES, LINK_TEXT_MAX, LINKS_MAX, TEXT_MAX, URL_MAX } from "../constants.ts";
import type { ReaderLimits } from "./reader.ts";

/** The variable that holds the browser service's endpoint, ws://browser:3000/ in Compose. */
export const WS_URL_VARIABLE = "BROWSER_WS_URL";
/** The schemes the endpoint may have. */
export const WS_PROTOCOLS: ReadonlySet<string> = new Set(["ws:", "wss:"]);

/** One page, the document's fetch, the connection and the read included: past it, browser_timeout. */
export const RENDER_TIMEOUT_MS = 15_000;
/** The connection to the service, at most: a service down, or busy past it, is browser_unavailable. */
export const CONNECT_TIMEOUT_MS = 5_000;
/** After the load event, how long the page may go on fetching before it is read. */
export const SETTLE_MS = 3_000;

/** The requests one page may send, its document and the redirects followed included. */
export const MAX_REQUESTS = 100;
/** The redirects one request follows, each hop through the egress rules again. */
export const MAX_REDIRECTS = 5;
/** One answer's body, at most: the document's past it is browser_too_large, another is not served. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * All of one page's answers together, at most. Each request holds a whole answer's room until its
 * size is known, so that three or four run at the same time, fewer as the page's room is used.
 */
export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
/** The longest Accept header of the page's that goes with a request; a longer one is not sent. */
export const ACCEPT_MAX = 256;

/** What the document's request accepts, and the media types a document may have. */
export const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
export const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);
/** The only content coding an answer may carry: the body is handed to the browser as it came. */
export const IDENTITY = "identity";
/** A redirect the egress client did not follow, having no Location: never handed to the browser. */
export const REDIRECT_STATUS = { min: 300, max: 399 } as const;
/** The schemes of a page's final URL. */
export const PAGE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** The kinds of request never sent: images, fonts, media and their text tracks, endless streams, app manifests. */
export const SKIPPED_TYPES: ReadonlySet<string> = new Set([
  "image",
  "font",
  "media",
  "texttrack",
  "eventsource",
  "manifest",
]);
/** The headers of an answer handed to the browser: no cookie, no length, no coding, no policy. */
export const FORWARDED_HEADERS: readonly string[] = [
  "content-type",
  "content-language",
  "refresh",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
];
/** How a request not sent ends: a navigation of the page aborted, which keeps the page as it was; any other blocked. */
export const ABORTED = "aborted";
export const BLOCKED = "blockedbyclient";

/**
 * The context's proxy: the discard port of the browser's own host, where nothing answers, for every
 * address, loopback included. What Chromium would send by itself, past the route filter (a
 * speculation rule's prefetch or prerender, a preconnect, a shared worker's requests, a worker's
 * WebSocket), fails there, and Chromium refuses a WebTransport through a proxy; a routed request
 * never reaches it, since the worker answers it.
 */
export const DEAD_PROXY = { server: "http://127.0.0.1:9", bypass: "<-loopback>" } as const;
/** Every call's fresh context: scripts on, no download, no service worker, a user agent that names Whytide. */
export const CONTEXT: BrowserContextOptions = {
  acceptDownloads: false,
  bypassCSP: true,
  javaScriptEnabled: true,
  proxy: DEAD_PROXY,
  serviceWorkers: "block",
  userAgent: "Mozilla/5.0 (compatible; Whytide/1.0; +https://www.whytide.com)",
};
/**
 * What the transports script (transports.ts) takes from every document, frames and popups included:
 * WebRTC, whose UDP no proxy carries, and WebTransport, QUIC over UDP. A worker keeps WebTransport,
 * which the dead proxy stops there.
 */
export const REMOVED_GLOBALS: readonly string[] = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "WebTransport",
];

/** The egress rules' codes that refuse a URL: browser_blocked, with the code as the reason. */
export const BLOCKED_CODES: ReadonlySet<string> = new Set([
  "egress_bad_scheme",
  "egress_blocked_address",
  "egress_credentials_in_url",
  "egress_denied_host",
  "egress_insecure_redirect",
  "egress_invalid_url",
  "egress_port_not_allowed",
]);
export const EGRESS_TIMEOUT = "egress_timeout";
export const EGRESS_TOO_LARGE = "egress_too_large";
/** browser_provider_error's `details.reason` beside the egress client's own codes. */
export const REASONS = {
  notHtml: "not_html",
  encoded: "encoded",
  redirect: "redirect_without_location",
  urlTooLong: "url_too_long",
  unreadable: "unreadable",
  failed: "render_failed",
  requests: "too_many_requests",
  notGet: "not_get",
  ended: "render_ended",
} as const;

/** The reader the init script defines in each document, and its bounds (reader.ts). */
export const READER: ReaderLimits = {
  name: "__whytideReadPage",
  textMax: TEXT_MAX + 1,
  linksMax: LINKS_MAX,
  hrefMax: URL_MAX,
  linkTextMax: LINK_TEXT_MAX * 5,
  anchorsMax: 5_000,
  schemes: LINK_SCHEMES,
};
/** The reader's answer, at most: its text, and each link's href and text with their lengths. */
export const ANSWER_MAX =
  READER.textMax + READER.linksMax * (READER.hrefMax + READER.linkTextMax + 16) + 16;

/** Why create() refuses BROWSER_WS_URL, after the variable's name in config_invalid's `details.variables`. */
export const REFUSALS = {
  required: "required by the playwright adapter",
  protocol: "a ws: or wss: URL",
} as const;
/** Why the adapter refuses a test's options outside APP_ENV=test, in adapter_invalid's details. */
export const TEST_ONLY = "test hosts and a test resolver are taken under APP_ENV=test only";
