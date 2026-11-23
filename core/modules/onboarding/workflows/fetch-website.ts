// The website fetch, the first activity of onboarding_draft_company_knowledge (README "The website
// fetch"; docs/security.md): the platform's site reader (readSite, gamma-en-065) reads robots.txt, the
// home page, then up to ONBOARDING_FETCH_MAX_PAGES - 1 of its links in onboarding's preference
// (FETCH_PREFERRED), each through fetchSafe, the platform's egress client: one megabyte and ten
// seconds a page, sixty seconds in all, HTML only. No tenant run is open while it reads; one run then
// writes the pages, each with its content hash, and the status, while the run is still the latest
// Draft. The run ends `failed` with the egress code of robots.txt or the home page, or fetch_failed
// when the home page is not a readable HTML page or robots.txt disallows it; another page that fails
// is left out. A Draft from documents alone (no website) fetches nothing: the run is `fetched` with no
// page and goes to the drafter. Nothing it logs or returns carries an address or a text.
import { createHash } from "node:crypto";
import { heartbeat } from "@temporalio/activity";
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, readSite, SITE_CODES } from "@whytide/platform";
import {
  type DraftRun,
  draftWebsite,
  type FetchedPage,
  type FetchOutcome,
  type FetchResult,
  recordFetch,
} from "../domain/draft.ts";
import { settings } from "../settings.ts";
import { FETCH_PREFERRED } from "./constants.ts";

/** The reader's bounds, the platform's: a page's text here is at most FETCH_LIMITS.text. */
export { FETCH_LIMITS } from "@whytide/platform";

/**
 * The activity: the run's website read and its outcome written, unless a later Draft superseded it;
 * without a website, no request and no page.
 */
export async function fetchWebsite(
  run: DraftRun,
  context: ActivityContext<TenantClient>,
): Promise<FetchResult> {
  const latest = await context.tenant(() => draftWebsite(run));
  if (latest === null) return { status: "superseded", pages: 0 };
  const { website } = latest;
  const outcome: FetchOutcome =
    website === null
      ? { ok: true, pages: [] }
      : await readWebsite(new URL(website), settings.ONBOARDING_FETCH_MAX_PAGES);
  return context.tenant(() => recordFetch(run, outcome));
}

/** Reads the site of `home` within the sixty seconds, a heartbeat before each page. */
async function readWebsite(home: URL, maxPages: number): Promise<FetchOutcome> {
  const read = await readSite(home, { maxPages, preferred: FETCH_PREFERRED, beat: heartbeat });
  if (!read.ok) {
    // A disallowed home page is a failed fetch, as before the reader moved.
    const code = read.code === SITE_CODES.disallowed ? SITE_CODES.unreadable : read.code;
    return { ok: false, code };
  }
  const pages = read.pages.map(
    ({ url, status, title, text }): FetchedPage => ({
      url,
      status,
      fetchedAt: new Date(),
      title,
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
    }),
  );
  return { ok: true, pages };
}
