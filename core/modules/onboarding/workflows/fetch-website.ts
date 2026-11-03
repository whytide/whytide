// The website fetch, the first activity of onboarding_draft_company_knowledge (README "The website
// fetch"; docs/security.md): robots.txt, the home page, then up to ONBOARDING_FETCH_MAX_PAGES - 1 of
// its links in the preference order, each through fetchSafe, the platform's egress client: one
// megabyte and ten seconds a page, sixty seconds in all, HTML only. No tenant run is open while it
// fetches; one run then writes the pages and the status, while the run is still the latest Draft.
// The run ends `failed` with the egress code of robots.txt or the home page, or fetch_failed when the
// home page is not a readable HTML page; another page that fails is left out. Nothing it logs or
// returns carries an address or a text.
import { createHash } from "node:crypto";
import { heartbeat } from "@temporalio/activity";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  type FetchSafeResponse,
  fetchSafe,
  isAppError,
} from "@whytide/platform";
import {
  type DraftRun,
  draftWebsite,
  type FetchedPage,
  type FetchOutcome,
  type FetchResult,
  recordFetch,
} from "../domain/draft.ts";
import { type PageLink, parseHtml } from "../domain/pages/html.ts";
import { MAX_URL, selectPages } from "../domain/pages/links.ts";
import { DISALLOW_ALL, isAllowed, parseRobots, type RobotsRules } from "../domain/pages/robots.ts";
import { settings } from "../settings.ts";

export const FETCH_LIMITS = {
  pageBytes: 1_048_576,
  pageMs: 10_000,
  totalMs: 60_000,
  /** Characters of text kept per page. */
  text: 50_000,
  /** RFC 9309 asks a crawler to read 500 KiB of a robots.txt at least. */
  robotsBytes: 512_000,
  redirects: 5,
} as const;
const HTML = new Set(["text/html", "application/xhtml+xml"]);

type Get = (url: URL, maxBytes: number, accept: string) => Promise<FetchSafeResponse>;
type Read = { readonly page: FetchedPage; readonly links: readonly PageLink[] } | { code: string };

/** The activity: the run's website read and its outcome written, unless a later Draft superseded it. */
export async function fetchWebsite(
  run: DraftRun,
  context: ActivityContext<TenantClient>,
): Promise<FetchResult> {
  const website = await context.tenant(() => draftWebsite(run));
  if (website === null) return { status: "superseded", pages: 0 };
  const outcome = await readWebsite(new URL(website), settings.ONBOARDING_FETCH_MAX_PAGES);
  return context.tenant(() => recordFetch(run, outcome));
}

/** Reads the site of `home` within the sixty seconds, a heartbeat before each page. */
async function readWebsite(home: URL, maxPages: number): Promise<FetchOutcome> {
  const deadline = Date.now() + FETCH_LIMITS.totalMs;
  const get: Get = (url, maxBytes, accept) => {
    const timeoutMs = Math.max(1, Math.min(FETCH_LIMITS.pageMs, deadline - Date.now()));
    const redirects = FETCH_LIMITS.redirects;
    return fetchSafe(url, { maxBytes, truncate: true, timeoutMs, maxRedirects: redirects, accept });
  };
  heartbeat(0);
  let rules: RobotsRules;
  try {
    rules = robotsRules(
      await get(new URL("/robots.txt", home), FETCH_LIMITS.robotsBytes, "text/plain"),
    );
  } catch (error) {
    return { ok: false, code: egressCode(error) };
  }
  if (!isAllowed(rules, home)) return { ok: false, code: "fetch_failed" };
  heartbeat(0);
  const first = await readPage(home, get);
  if ("code" in first) return { ok: false, code: first.code };
  const pages = [first.page];
  const allowed = (url: URL) => isAllowed(rules, url);
  for (const url of selectPages(new URL(first.page.url), first.links, maxPages - 1, allowed)) {
    if (Date.now() >= deadline) break;
    heartbeat(pages.length);
    const read = await readPage(url, get);
    // Two links that redirect to one page keep it once.
    if ("page" in read && !pages.some((page) => page.url === read.page.url)) pages.push(read.page);
  }
  return { ok: true, pages };
}

/** RFC 9309 §2.3.1: a 4xx means no rules, anything else but a 2xx that nothing may be read. */
function robotsRules(response: FetchSafeResponse): RobotsRules {
  if (response.status >= 200 && response.status < 300) {
    return parseRobots(response.body.toString("utf8"));
  }
  return response.status >= 400 && response.status < 500 ? [] : DISALLOW_ALL;
}

/** One page: an egress code, fetch_failed when it is no HTML page, else its text and links. */
async function readPage(url: URL, get: Get): Promise<Read> {
  let response: FetchSafeResponse;
  try {
    response = await get(url, FETCH_LIMITS.pageBytes, "text/html");
  } catch (error) {
    return { code: egressCode(error) };
  }
  const [type = "", ...parameters] = String(response.headers["content-type"] ?? "").split(";");
  const charset = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replaceAll('"', "");
  // A compressed body is never inflated (core/packages/platform/README.md "Egress: fetchSafe").
  const encoded = (response.headers["content-encoding"] ?? "identity") !== "identity";
  const ok = response.status >= 200 && response.status < 300;
  if (
    !ok ||
    !HTML.has(type.trim().toLowerCase()) ||
    encoded ||
    response.finalUrl.length > MAX_URL
  ) {
    return { code: "fetch_failed" };
  }
  const parsed = parseHtml(decode(response.body, charset));
  const cut = parsed.text.length > FETCH_LIMITS.text;
  // Never half of a surrogate pair at the cut.
  const high = cut && /[\uD800-\uDBFF]/.test(parsed.text[FETCH_LIMITS.text - 1] ?? "");
  const text = cut ? parsed.text.slice(0, FETCH_LIMITS.text - (high ? 1 : 0)) : parsed.text;
  const page: FetchedPage = {
    url: response.finalUrl,
    status: response.truncated || cut ? "truncated" : "fetched",
    fetchedAt: new Date(),
    title: parsed.title,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
  return { page, links: parsed.links };
}

/** The body in its declared charset, UTF-8 when it declares none or one Node does not know. */
function decode(body: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** The egress client's code; anything else is a fault, thrown so that Temporal retries the fetch. */
function egressCode(error: unknown): string {
  if (isAppError(error) && error.code.startsWith("egress_")) return error.code;
  throw error;
}
