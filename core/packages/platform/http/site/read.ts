// The site reader (README "The site reader"; gamma-en-065, moved from onboarding's website fetch):
// robots.txt, the home page, then up to `maxPages - 1` of its links in the caller's preference, each
// through fetchSafe: one megabyte, ten seconds and five redirects a page, `totalMs` in all, HTML only,
// never inflated; never a path robots.txt disallows. The read ends with the egress code of robots.txt
// or the home page, `site_disallowed` when robots.txt allows no reading of the home page, or
// `fetch_failed` when the home page is no readable HTML page; another page that fails is left out.
// `readPage` (gamma-wr-020) reads one page the caller names, robots.txt of its host first, an HTML
// page or a PDF file as text. Nothing either throws or answers but its pages carries an address or a
// text.
import { isAppError } from "../../errors/index.ts";
import { type FetchSafeResponse, fetchSafe } from "../client.ts";
import { FETCH_LIMITS, HTML_TYPES, PAGE_ACCEPT, PDF_TYPE, SITE_CODES } from "./constants.ts";
import { type PageLink, parseHtml } from "./html.ts";
import { mailtoOf, type PreferredPages, selectPages } from "./links.ts";
import { readPdf } from "./pdf.ts";
import { DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "./robots.ts";

/** A link of a page: absolute, http or https, and whether it sits in the page's navigation. */
export type SiteLink = { readonly href: string; readonly nav: boolean };
/**
 * A page read: its address after redirects, its title, text and links; `truncated` when cut; the
 * addresses of its `mailto:` links, footers' included (gamma-en-085).
 */
export type SitePage = {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly SiteLink[];
  readonly mailto: readonly string[];
  readonly status: "fetched" | "truncated";
};
/** The pages, the home page first, every one robots.txt allows; or the code the read ended with. */
export type SiteRead =
  | { readonly ok: true; readonly pages: readonly SitePage[] }
  | { readonly ok: false; readonly code: string };
export type ReadSiteOptions = {
  /** The pages at most, the home page included. */
  readonly maxPages: number;
  /** The caller's groups of path words, in their order (links.ts). */
  readonly preferred: PreferredPages;
  /** The whole read's bound in milliseconds; FETCH_LIMITS.totalMs when absent. */
  readonly totalMs?: number;
  /** Called before robots.txt and before each page with the pages read so far: a heartbeat. */
  readonly beat?: (pages: number) => void;
  /** A host the read never requests, a redirect hop's too (as `ReadPageOptions.refuseHost`; gamma-wr-050). */
  readonly refuseHost?: RefuseHost;
};

/** A host (lower case) the read never requests, asked for the page's and each redirect hop's. */
export type RefuseHost = (host: string) => boolean;

/** The robots.txt rules of the hosts a caller's run has read, by origin; `readPage` fills it. */
export type RobotsByHost = Map<string, RobotsRules>;
export type ReadPageOptions = {
  /** The whole read's bound in milliseconds, robots.txt included; FETCH_LIMITS.totalMs when absent. */
  readonly totalMs?: number;
  /** Called before robots.txt and before the page: a heartbeat. */
  readonly beat?: () => void;
  /** The rules of hosts read earlier in the caller's run, so that a host's robots.txt is asked once. */
  readonly robots?: RobotsByHost;
  /**
   * A host the caller never lets the read request: asked before robots.txt, the page and every
   * redirect hop is requested; a refused one answers `egress_denied_host` with no request to it.
   */
  readonly refuseHost?: RefuseHost;
};
/** The page, or the code the read ended with. */
export type PageRead =
  | { readonly ok: true; readonly page: SitePage }
  | { readonly ok: false; readonly code: string };

type Get = (url: URL, maxBytes: number, accept: string) => Promise<FetchSafeResponse>;
type Read = { readonly page: SitePage; readonly links: readonly PageLink[] } | { code: string };

/** fetchSafe within the page limits and the read's `deadline`. */
function getWithin(deadline: number, refuseHost?: RefuseHost): Get {
  return (url, maxBytes, accept) => {
    const timeoutMs = Math.max(1, Math.min(FETCH_LIMITS.pageMs, deadline - Date.now()));
    const redirects = FETCH_LIMITS.redirects;
    const bounds = { maxBytes, truncate: true, timeoutMs, maxRedirects: redirects, accept };
    return fetchSafe(url, refuseHost === undefined ? bounds : { ...bounds, refuseHost });
  };
}

/** Reads the site of `home` within its bound; a fault (no egress code) is thrown. */
export async function readSite(home: URL, options: ReadSiteOptions): Promise<SiteRead> {
  const { maxPages, preferred, totalMs = FETCH_LIMITS.totalMs, beat = () => {} } = options;
  const deadline = Date.now() + totalMs;
  const get = getWithin(deadline, options.refuseHost);
  beat(0);
  let rules: RobotsRules;
  try {
    rules = robotsRules(
      await get(new URL("/robots.txt", home), FETCH_LIMITS.robotsBytes, "text/plain"),
    );
  } catch (error) {
    return { ok: false, code: egressCode(error) };
  }
  if (!isAllowed(rules, home)) return { ok: false, code: SITE_CODES.disallowed };
  beat(0);
  const first = await fetchPage(home, get, false);
  if ("code" in first) return { ok: false, code: first.code };
  const pages = [first.page];
  const allowed = (url: URL) => isAllowed(rules, url);
  const next = selectPages(new URL(first.page.url), first.links, maxPages - 1, allowed, preferred);
  for (const url of next) {
    if (Date.now() >= deadline) break;
    beat(pages.length);
    const read = await fetchPage(url, get, false);
    // Two links that redirect to one page keep it once.
    if ("page" in read && !pages.some((page) => page.url === read.page.url)) pages.push(read.page);
  }
  return { ok: true, pages };
}

/**
 * One page the caller names (gamma-wr-020): robots.txt of its host first, from `options.robots` when
 * an earlier read of the run filled it, else asked once and kept there; then the page, an HTML page
 * or a PDF file's text, never a link followed. A fault (no egress code) is thrown, as readSite's.
 */
export async function readPage(url: URL, options: ReadPageOptions = {}): Promise<PageRead> {
  const { totalMs = FETCH_LIMITS.totalMs, beat = () => {}, robots = new Map() } = options;
  const deadline = Date.now() + totalMs;
  const get = getWithin(deadline, options.refuseHost);
  let rules = robots.get(url.origin);
  if (rules === undefined) {
    beat();
    try {
      rules = robotsRules(
        await get(new URL("/robots.txt", url), FETCH_LIMITS.robotsBytes, "text/plain"),
      );
    } catch (error) {
      return { ok: false, code: egressCode(error) };
    }
    robots.set(url.origin, rules);
  }
  if (!isAllowed(rules, url)) return { ok: false, code: SITE_CODES.disallowed };
  beat();
  const read = await fetchPage(url, get, true, deadline);
  return "page" in read ? { ok: true, page: read.page } : { ok: false, code: read.code };
}

/** RFC 9309 §2.3.1: a 4xx means no rules, anything else but a 2xx that nothing may be read. */
function robotsRules(response: FetchSafeResponse): RobotsRules {
  if (response.status >= 200 && response.status < 300) {
    return parseRobots(response.body.toString("utf8"));
  }
  return response.status >= 400 && response.status < 500 ? [] : DISALLOW_ALL;
}

/**
 * One page: an egress code, fetch_failed when it is no HTML page (nor, with `pdf`, a PDF file within
 * its bounds and with text in it), else its text and links.
 */
async function fetchPage(url: URL, get: Get, pdf: boolean, deadline = Infinity): Promise<Read> {
  let response: FetchSafeResponse;
  try {
    const bound = pdf ? FETCH_LIMITS.pdfBytes : FETCH_LIMITS.pageBytes;
    response = await get(url, bound, pdf ? PAGE_ACCEPT : "text/html");
  } catch (error) {
    return { code: egressCode(error) };
  }
  const [type = "", ...parameters] = String(response.headers["content-type"] ?? "").split(";");
  const mediaType = type.trim().toLowerCase();
  const charset = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replaceAll('"', "");
  // A compressed body is never inflated (README "Egress: fetchSafe").
  const encoded = (response.headers["content-encoding"] ?? "identity") !== "identity";
  const ok = response.status >= 200 && response.status < 300;
  const file = pdf && mediaType === PDF_TYPE;
  if (
    !ok ||
    !(HTML_TYPES.has(mediaType) || file) ||
    encoded ||
    response.finalUrl.length > FETCH_LIMITS.url
  ) {
    return { code: SITE_CODES.unreadable };
  }
  if (file) return pdfPage(response, deadline);
  // The page's own bound, when the read allowed a larger body for a PDF file.
  const cutBody = response.body.length > FETCH_LIMITS.pageBytes;
  const body = cutBody ? response.body.subarray(0, FETCH_LIMITS.pageBytes) : response.body;
  const parsed = parseHtml(decode(body, charset));
  const cut = parsed.text.length > FETCH_LIMITS.text;
  // Never half of a surrogate pair at the cut.
  const high = cut && /[\uD800-\uDBFF]/.test(parsed.text[FETCH_LIMITS.text - 1] ?? "");
  const text = cut ? parsed.text.slice(0, FETCH_LIMITS.text - (high ? 1 : 0)) : parsed.text;
  const page: SitePage = {
    url: response.finalUrl,
    status: response.truncated || cutBody || cut ? "truncated" : "fetched",
    title: parsed.title,
    text,
    links: absolute(response.finalUrl, parsed.links),
    mailto: mailtoOf(parsed.links),
  };
  return { page, links: parsed.links };
}

/** A PDF file as a page: its text and title, no links; fetch_failed past a bound or with no text. */
async function pdfPage(response: FetchSafeResponse, deadline: number): Promise<Read> {
  // A body cut at the bound is a file past it.
  if (response.truncated) return { code: SITE_CODES.unreadable };
  // The parser takes its array over: a copy of its own, never the body's.
  const bytes = new Uint8Array(response.body);
  const read = await readPdf(bytes, Math.min(FETCH_LIMITS.pageMs, deadline - Date.now()));
  if (read === null) return { code: SITE_CODES.unreadable };
  const page: SitePage = {
    url: response.finalUrl,
    status: read.cut ? "truncated" : "fetched",
    title: read.title,
    text: read.text,
    links: [],
    mailto: [],
  };
  return { page, links: [] };
}

/** The links resolved against the page, http and https only, at most FETCH_LIMITS.url long. */
function absolute(base: string, links: readonly PageLink[]): SiteLink[] {
  return links.flatMap(({ href, nav }) => {
    const url = href.length > FETCH_LIMITS.url ? null : URL.parse(href, base);
    const web = url !== null && (url.protocol === "http:" || url.protocol === "https:");
    return web && url.href.length <= FETCH_LIMITS.url ? [{ href: url.href, nav }] : [];
  });
}

/** The body in its declared charset, UTF-8 when it declares none or one Node does not know. */
function decode(body: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The egress client's code; anything else is a fault, thrown so that the caller's retry runs. */
function egressCode(error: unknown): string {
  if (isAppError(error) && error.code.startsWith("egress_")) return error.code;
  throw error;
}
