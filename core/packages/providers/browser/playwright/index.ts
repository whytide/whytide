// The playwright adapter of the browser port (README.md): a page rendered in a headless Chromium in
// the browser service, reached at BROWSER_WS_URL through playwright-core's client. No key. Per
// call, the document is fetched first through the egress client, so that a refused page never
// reaches the service; then a fresh context, scripts on, no storage, no download, no service
// worker, a user agent that names Whytide; every request the browser routes goes through the route
// filter (requests.ts), which fetches it in the worker and hands the answer to the browser;
// WebSockets are closed; what Chromium would send by itself goes to a proxy where nothing answers,
// and WebRTC and WebTransport are taken from every document (transports.ts), so that nothing the
// page asks for leaves but through the egress rules. At most RENDER_TIMEOUT_MS a page, then its
// text and links are read (reader.ts) and the browser closed, the context with it. No error carries
// a URL, a page's text or Playwright's message, which holds both.
import {
  AppError,
  type FetchSafeResponse,
  isAppError,
  parseHostList,
  platformConfig,
  type Resolver,
} from "@whytide/platform";
import {
  type Browser,
  chromium,
  type Page,
  type Request,
  type Route,
  type WebSocketRoute,
} from "playwright-core";
import { defineAdapter, type PortImplementation, patternErrors } from "../../_pattern/index.ts";
import { URL_MAX } from "../constants.ts";
import { browserPort, type RenderedPage } from "../port.ts";
import { playwrightConfig } from "./config.ts";
import {
  ABORTED,
  ACCEPT_MAX,
  ANSWER_MAX,
  BLOCKED,
  CONNECT_TIMEOUT_MS,
  CONTEXT,
  DOCUMENT_ACCEPT,
  FORWARDED_HEADERS,
  HTML_TYPES,
  IDENTITY,
  PAGE_SCHEMES,
  READER,
  REASONS,
  REDIRECT_STATUS,
  REFUSALS,
  REMOVED_GLOBALS,
  RENDER_TIMEOUT_MS,
  SETTLE_MS,
  SKIPPED_TYPES,
  TEST_ONLY,
  WS_PROTOCOLS,
  WS_URL_VARIABLE,
} from "./constants.ts";
import { installReader, pageContent } from "./reader.ts";
import { type Egress, PageRequests, providerError } from "./requests.ts";
import { removeTransports } from "./transports.ts";

const { errors } = browserPort;

/**
 * A test's options, taken under APP_ENV=test only: the local test site's hosts, `host` or
 * `host:port` entries the egress rules let through as EGRESS_ALLOW_HOSTS would, and a resolver for
 * the test's host names. Production refuses both.
 */
export type TestOptions = { readonly testHosts?: readonly string[]; readonly resolve?: Resolver };

/** The adapter on the service at `wsUrl`; `test` only under APP_ENV=test. */
export function playwrightBrowser(
  wsUrl: string,
  test?: TestOptions,
): PortImplementation<typeof browserPort> {
  if (test !== undefined && platformConfig.APP_ENV !== "test") {
    const details = { port: browserPort.name, adapter: "playwright", reason: TEST_ONLY };
    throw new AppError(patternErrors.adapter_invalid, { details });
  }
  const hosts = test?.testHosts;
  const egress: Egress = {
    lists: hosts === undefined ? undefined : { allowHosts: parseHostList(hosts.join(",")) },
    resolve: test?.resolve,
  };
  return { renderPage: ({ url }) => render(wsUrl, url, egress) };
}

export const playwrightAdapter = defineAdapter(browserPort, {
  name: "playwright",
  requires: [WS_URL_VARIABLE],
  create: () => playwrightBrowser(serviceUrl()),
});

/** BROWSER_WS_URL, a ws: or wss: URL; a refusal names the variable, never the value. */
function serviceUrl(): string {
  const { BROWSER_WS_URL: value } = playwrightConfig();
  if (!value) throw refused(REFUSALS.required);
  const url = URL.parse(value);
  if (url === null || !WS_PROTOCOLS.has(url.protocol)) throw refused(REFUSALS.protocol);
  return url.href;
}

const refused = (reason: string) =>
  new AppError("config_invalid", {
    details: { block: "packages/providers", variables: [`${WS_URL_VARIABLE}: ${reason}`] },
  });

/**
 * The page at `url`: its document first, through the egress rules; then the browser, until the page
 * is read, a navigation of its own fails the call, or the deadline passes.
 */
async function render(wsUrl: string, url: string, egress: Egress): Promise<RenderedPage> {
  const requests = new PageRequests(egress, RENDER_TIMEOUT_MS);
  try {
    const document = await fetchDocument(requests, url);
    const browser = await connect(wsUrl, requests.left());
    const session = read(browser, document, requests);
    // A session the call no longer waits for ends under the closed browser, and that end is nobody's.
    session.catch(() => undefined);
    try {
      return await beforeDeadline(Promise.race([session, requests.failed]), requests.left());
    } catch (error) {
      throw requests.failure ?? asPortError(error);
    } finally {
      // Closes the connection; the service closes the browser and its context with it.
      await browser.close().catch(() => undefined);
    }
  } finally {
    requests.close();
  }
}

/** The document, HTML, uncoded, over no redirect left unfollowed, and its final URL within bounds. */
async function fetchDocument(requests: PageRequests, url: string): Promise<FetchSafeResponse> {
  const document = await requests.fetch(url, DOCUMENT_ACCEPT);
  const reason = documentProblem(document);
  if (reason !== undefined) throw providerError(reason);
  if (document.finalUrl.length > URL_MAX) throw providerError(REASONS.urlTooLong);
  return document;
}

function documentProblem(answer: FetchSafeResponse): string | undefined {
  const type = header(answer, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!HTML_TYPES.has(type)) return REASONS.notHtml;
  return answerProblem(answer);
}

/** Why an answer is not handed to the browser: a coded body, or a redirect with no Location. */
function answerProblem(answer: FetchSafeResponse): string | undefined {
  const coding = header(answer, "content-encoding")?.trim().toLowerCase();
  if (coding !== undefined && coding !== IDENTITY) return REASONS.encoded;
  if (answer.status >= REDIRECT_STATUS.min && answer.status <= REDIRECT_STATUS.max) {
    return REASONS.redirect;
  }
  return undefined;
}

const header = (answer: FetchSafeResponse, name: string): string | undefined => {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
};

async function connect(wsUrl: string, left: number): Promise<Browser> {
  if (left <= 0) throw new AppError(errors.browser_timeout);
  try {
    return await chromium.connect(wsUrl, { timeout: Math.min(CONNECT_TIMEOUT_MS, left) });
  } catch {
    throw new AppError(errors.browser_unavailable);
  }
}

/** The page the browser rendered from the document, in the port's words. */
async function read(
  browser: Browser,
  document: FetchSafeResponse,
  requests: PageRequests,
): Promise<RenderedPage> {
  const context = await browser.newContext(CONTEXT);
  const tab: Tab = { served: false, status: document.status };
  await context.routeWebSocket(everything, closeSocket);
  await context.route(everything, (route) => answer(route, tab, document, requests));
  await context.addInitScript(removeTransports, REMOVED_GLOBALS);
  await context.addInitScript(installReader, READER);
  const page = await context.newPage();
  tab.page = page;
  context.on("page", (other) => {
    if (other !== page) other.close().catch(() => undefined);
  });
  await page.goto(document.finalUrl, { waitUntil: "load", timeout: 0 }).catch(async () => {
    if (requests.failure) throw requests.failure;
    // The page went on to a document of its own before it loaded: that one is read, once loaded.
    await page.waitForLoadState("load", { timeout: 0 });
  });
  const settle = Math.max(1, Math.min(SETTLE_MS, requests.left()));
  await page.waitForLoadState("networkidle", { timeout: settle }).catch(() => undefined);
  const content = pageContent(await evaluate(page), ANSWER_MAX);
  if (requests.failure) throw requests.failure;
  if (content === undefined) throw providerError(REASONS.unreadable);
  return { finalUrl: finalUrl(page.url(), document.finalUrl), status: tab.status, ...content };
}

/** The reader's answer; once more after a navigation of the page's own replaced the document. */
async function evaluate(page: Page): Promise<unknown> {
  const call = `${READER.name}()`;
  try {
    return await page.evaluate(call);
  } catch {
    await page.waitForLoadState("load", { timeout: 0 });
    return page.evaluate(call).catch(() => undefined);
  }
}

type Tab = { page?: Page; served: boolean; status: number };

/**
 * The route filter, on every request of every page of the context. The first navigation of the
 * page's main frame gets the document already fetched; a navigation of any other frame or page, a
 * request but GET, and an image, a font or a medium are never sent; the rest is fetched through the
 * egress rules and handed to the browser, or aborted. A later navigation of the main frame is
 * followed as a redirect is: checked as the document was, and refused or failed, it fails the call
 * at once with its code, browser_blocked for a blocked address.
 */
async function answer(
  route: Route,
  tab: Tab,
  document: FetchSafeResponse,
  requests: PageRequests,
): Promise<void> {
  const request = route.request();
  const navigation = request.isNavigationRequest();
  const main = navigation && tab.page !== undefined && frameOf(request) === tab.page.mainFrame();
  try {
    if (main && !tab.served) {
      tab.served = true;
      return await fulfill(route, document);
    }
    if (navigation && !main) return await abort(route, BLOCKED);
    if (main && request.method() !== "GET") throw providerError(REASONS.notGet);
    if (request.method() !== "GET" || SKIPPED_TYPES.has(request.resourceType())) {
      return await abort(route, BLOCKED);
    }
    const accept = request.headers().accept;
    const fetched = await requests.fetch(
      request.url(),
      accept !== undefined && accept.length <= ACCEPT_MAX ? accept : undefined,
    );
    const reason = main ? documentProblem(fetched) : answerProblem(fetched);
    if (reason !== undefined) throw providerError(reason);
    if (main) tab.status = fetched.status;
    await fulfill(route, fetched);
  } catch (error) {
    if (main) requests.fail(asPortError(error));
    await abort(route, main ? ABORTED : BLOCKED);
  }
}

/** The answer as the browser gets it: its status, the headers it may have, its body as it came. */
function fulfill(route: Route, fetched: FetchSafeResponse): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = header(fetched, name);
    if (value !== undefined) headers[name] = value;
  }
  return route
    .fulfill({ status: fetched.status, headers, body: fetched.body })
    .catch(() => undefined);
}

const abort = (route: Route, code: string): Promise<void> =>
  route.abort(code).catch(() => undefined);

/** The request's frame; none for a request of a page not yet open. */
function frameOf(request: Request) {
  try {
    return request.frame();
  } catch {
    return undefined;
  }
}

const everything = (): boolean => true;
const closeSocket = (socket: WebSocketRoute): Promise<void> => socket.close();

/** Where the page ended: the browser's URL when it is http or https and fits, else the document's. */
function finalUrl(current: string, fallback: string): string {
  const url = URL.parse(current);
  return url !== null && PAGE_SCHEMES.has(url.protocol) && url.href.length <= URL_MAX
    ? url.href
    : fallback;
}

function beforeDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError(errors.browser_timeout)), Math.max(ms, 0));
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A port error as it is; anything else, Playwright's included, as browser_provider_error, without it. */
function asPortError(error: unknown): AppError {
  if (isAppError(error) && Object.hasOwn(errors, error.code)) return error;
  return providerError(REASONS.failed);
}
