// One page of a research run, read (README.md "Web research"; gamma-wr-045): through platform's
// `readPage`, the only fetch, which reads robots.txt of the page's host first and refuses what the
// egress client refuses; a page that shows too little text without scripts is asked again of the
// `browser` port when one is set, which renders only a page robots.txt allowed. Every host's
// robots.txt is asked once a run: one map of rules per run is kept in the process, the oldest run's
// let go past ROBOTS_RUNS_KEPT. LinkedIn and the hosts never fetched are refused to the reader for
// every request it makes, a redirect hop's too, so none is requested; the browser's rendered page
// that ends on one is not used. Nothing of the page, its address or its text is logged: the answer is a status.
import {
  type PageRead,
  platformConfig,
  type ReadPageOptions,
  type RobotsByHost,
  readPage,
  SITE_CODES,
  type SitePage,
} from "@whytide/platform";
import {
  type BoundAdapter,
  browserConfig,
  browserPort,
  getAdapter,
  type RenderedPage,
} from "@whytide/providers";
import { PAGE_TOTAL_MS, ROBOTS_RUNS_KEPT, THIN_PAGE_CHARS } from "./constants.ts";
import { neverFetched } from "./pages.ts";

/** The page read, whether the browser's text replaced the plain page's; or why there is none. */
export type PageAnswer =
  | { readonly status: "read"; readonly page: SitePage; readonly rendered: boolean }
  | { readonly status: "closed" | "failed" };

type Reader = (url: URL, options: ReadPageOptions) => Promise<PageRead>;
type Browser = BoundAdapter<typeof browserPort>;

let reader: Reader = readPage;
let browser: Promise<Browser | null> | undefined;
const robotsOfRuns = new Map<string, RobotsByHost>();

/**
 * For tests (testing/): a reader in place of platform's, which a test uses to serve the https
 * addresses a search answers (the port's results are https) from a server of its own on 127.0.0.1;
 * undefined restores platform's. Any environment but APP_ENV=test refuses it, as campaigns'
 * useGateFreshMs is refused.
 */
export function useReadPage(next: Reader | undefined): void {
  if (platformConfig.APP_ENV !== "test") throw new Error("useReadPage: only under APP_ENV=test");
  reader = next ?? readPage;
}

/** For tests: the process's memory of robots.txt rules and of the browser adapter, emptied; refused outside APP_ENV=test. */
export function forgetReads(): void {
  if (platformConfig.APP_ENV !== "test") throw new Error("forgetReads: only under APP_ENV=test");
  robotsOfRuns.clear();
  browser = undefined;
}

/** The run's map of robots.txt rules by origin, made at the run's first page. */
function robotsOf(runId: string): RobotsByHost {
  const known = robotsOfRuns.get(runId);
  if (known !== undefined) return known;
  const made: RobotsByHost = new Map();
  robotsOfRuns.set(runId, made);
  for (const [oldest] of robotsOfRuns) {
    if (robotsOfRuns.size <= ROBOTS_RUNS_KEPT) break;
    robotsOfRuns.delete(oldest);
  }
  return made;
}

/**
 * The page of `url` for the run: `closed` when its host's robots.txt disallows it, `failed` for any
 * other code the reader answers (no readable page, an egress refusal) or a redirect onto a host never
 * fetched; a fault, which is no code, is thrown for the step's retry.
 */
export async function readResearchPage(runId: string, url: string): Promise<PageAnswer> {
  const target = URL.parse(url);
  if (target === null) return { status: "failed" };
  const options = { totalMs: PAGE_TOTAL_MS, robots: robotsOf(runId), refuseHost: neverFetched };
  const read = await reader(target, options);
  if (!read.ok) return { status: read.code === SITE_CODES.disallowed ? "closed" : "failed" };
  const finalHost = URL.parse(read.page.url)?.hostname;
  if (finalHost === undefined || neverFetched(finalHost)) return { status: "failed" };
  if (read.page.text.length >= THIN_PAGE_CHARS || PDF_PATH.test(finalPath(read.page.url))) {
    return { status: "read", page: read.page, rendered: false };
  }
  const shown = await rendered(read.page);
  return { status: "read", page: shown, rendered: shown !== read.page };
}

const PDF_PATH = /\.pdf$/iu;
const finalPath = (url: string): string => URL.parse(url)?.pathname ?? "";

/** The page as the browser renders it, when it gives more text; else the plain page. */
async function rendered(page: SitePage): Promise<SitePage> {
  const adapter = await browserOf();
  if (adapter === null) return page;
  let shown: RenderedPage;
  try {
    shown = await adapter.renderPage({ url: page.url });
  } catch {
    // browser_unavailable or any other code: the plain page stays.
    return page;
  }
  const { status, text } = shown;
  const finalHost = URL.parse(shown.finalUrl)?.hostname;
  if (finalHost === undefined || neverFetched(finalHost)) return page;
  if (status < 200 || status >= 300 || text.length <= page.text.length) return page;
  const links = shown.links.map(({ href }) => ({ href, nav: false }));
  return { ...page, text, links: [...page.links, ...links] };
}

/** PROVIDER_BROWSER's adapter, loaded once; none when unset or when it cannot load. */
function browserOf(): Promise<Browser | null> {
  const selector = browserConfig.PROVIDER_BROWSER;
  if (selector === undefined) return Promise.resolve(null);
  browser ??= getAdapter(browserPort, selector).catch(() => null);
  return browser;
}
