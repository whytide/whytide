# The browser port

A page rendered in a headless browser, in our words ([architecture §9](../../../../docs/architecture.md#9-ports-and-adapters)): for a company website that shows nothing until its scripts run, so that the plain fetch gets an empty page (the owner's decision of 2026-11-13). One method, `renderPage`. `PROVIDER_BROWSER` (`config.ts`) names the one adapter: `playwright` where the browser service runs, `fake` in development and tests, empty for none. What enrichment renders, and robots.txt before it asks, are the caller's (gamma-en-065), never the port's.

## The method

```ts
import { browserConfig, browserPort, getAdapter } from "@whytide/providers";

const browser = await getAdapter(browserPort, browserConfig.PROVIDER_BROWSER); // at start, when set
const page = await browser.renderPage({ url: "https://example.com/" });
// page.finalUrl, page.status, page.text, page.links: [{ href, text }]
```

| Method | Takes | Gives |
|---|---|---|
| `renderPage` | `{ url }`: one URL, at most 2,048 characters; nothing else | `{ finalUrl, status, text, links }` |

The input takes a URL of any scheme, so that the adapter refuses a `file:` or `ftp:` one as `browser_blocked`; something that is not a URL, or a second field, is `browser_input_invalid` before any call. The output is a strict object, checked in every environment, production included (`alwaysCheckOutputs`): an answer off these shapes is `browser_output_invalid`.

| Field | Shape |
|---|---|
| `finalUrl` | where the page ended, after its redirects: http or https, at most 2,048 characters |
| `status` | the page's HTTP status, 100 to 599; a 404 page renders too, and the caller decides |
| `text` | the page's visible text, as a reader sees it, at most 50,000 characters, trimmed |
| `links` | at most 300, in the page's order, each once: `{ href, text }`, the href absolute (http, https or `mailto:`, at most 2,048 characters), the text the link's own, spaces collapsed, at most 200 characters |

## Codes

| Code | When |
|---|---|
| `browser_blocked` (403) | the egress rules refused the page, or a redirect it followed, or a navigation of the page's own: a scheme but http and https, a port but the scheme's own, a host on `EGRESS_DENY_HOSTS`, or one that resolves to a private, loopback, link-local or metadata address; `details.reason` is the rule's code, and nothing was sent there |
| `browser_timeout` (504) | the page took longer than its limit, 15 seconds for the playwright adapter |
| `browser_too_large` (413) | the page's document was larger than its limit |
| `browser_unavailable` (503) | the browser service did not answer: down, or busy past the connection's limit. An answer for the caller, who keeps the plain fetch's page, never a failed run |
| `browser_provider_error` (502) | anything else: the document not HTML, a navigation that failed, a page that could not be read; `details.reason`, a short code, never a message |
| `browser_input_invalid`, `browser_output_invalid`, `browser_error_unmapped` | the pattern's own ([../README.md](../README.md) "The boundary") |

Developer-facing: no message keys.

## What the port will never have

The page's HTML, a screenshot, a cookie, a login or any state kept between two calls: never a logged-in page, never LinkedIn. The output's strict shape refuses a field it does not declare. The port logs nothing and opens no span of its own; the egress client's span carries the host only, and no URL's path or query, and no page's text, reaches an error, a log line or a metric label (`tests/contract.test.ts`, `playwright/tests/`).

## Adapters

| `PROVIDER_BROWSER` | What it is |
|---|---|
| `playwright` | a headless Chromium in the browser service, behind three fences: [playwright/README.md](playwright/README.md) |
| `fake` | pages a test seeded, below |

`deploy/.env.example` names the fake; `deploy/.env.production.example` names `playwright`, which needs the browser service running (`deploy/README.md`). Empty binds nothing, and the caller keeps the plain fetch's page.

## The fake

Pages in memory, each under its URL as the URL parser writes it, so `https://Example.test` and `https://example.test/` are one page. `renderPage` answers a copy of the page seeded under the URL, its final URL that URL and its status 200 unless the seed gives them; any other URL, and every scheme but http and https, is `browser_blocked` with `details.reason: "not_seeded"`: the fake fetches nothing. `state.rendered` counts the pages it rendered. Module tests reach it as `(await getAdapter(browserPort, "fake")) as unknown as BrowserFake`. Its `create()` refuses `APP_ENV=production` with `adapter_invalid`: the fake never stands in for the browser on a server. Its controls, beside `recordedCalls`, `failNext`, `answerNext` and `reset()`:

| Control | Does |
|---|---|
| `seedPage(url, { text, links, finalUrl?, status? })` | the page `renderPage` answers for `url`, an http or https URL, until the next `reset()`; any other URL throws |
| `failNext("browser_unavailable")` | the next call throws it, as the service down does: a caller's test of its fallback |

## The contract suite

`contract.ts` holds `browserCases(world)`: the world's page rendered to its final URL, status, text and links in the port's words; a `file:`, `ftp:` and `javascript:` URL, the blocked addresses 10.0.0.1, 127.0.0.1, 169.254.169.254 and `::1` by their literals, and a port off the scheme's each `browser_blocked` with no request sent; an input off the port's shape refused before any call. A world gives `page()`, a page and its answer, and `requests()`, the requests sent for pages so far: the fake's rendered pages, or the egress client's requests on a local test site for the playwright adapter. `fake/tests/contract.test.ts` runs it on the fake, `tests/contract.test.ts` on the fake the registry gives for `PROVIDER_BROWSER=fake`, and `playwright/tests/contract.test.ts` on the browser service, where `BROWSER_WS_URL` is set.
