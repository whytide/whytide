# playwright: the browser adapter

**Covers.** `renderPage` of the [browser port](../README.md): the page rendered in a headless Chromium in the browser service ([deploy/README.md](../../../../../deploy/README.md) "The browser service"), reached at `BROWSER_WS_URL` through `playwright-core`'s client, at the version web's tests pin, 1.64.1; the service runs the same version, and refuses a client of another. For each call:

1. the document is fetched first, through the egress rules, so that a refused page never reaches the service;
2. a connection of its own to the service, then a fresh context: JavaScript on, no storage kept, no download, service workers blocked, a `<meta>` policy of the page's unable to stop the reader, and the user agent `Mozilla/5.0 (compatible; Whytide/1.0; +https://www.whytide.com)`;
3. the page loaded from the document, given 3 seconds after its load event to go quiet, then read;
4. the connection closed, and the service closes the browser and the context with it.

The page's own scripts run in the browser, never in the worker. No error carries a URL, a page's text or Playwright's message, which holds both. The adapter logs nothing and opens no span of its own: the egress client's `egress.fetch` spans name the host only.

**The fences.** Three ([security §5](../../../../../docs/rules/security.md#5-requests-uploads-and-egress)), so that a page reaches no private, loopback, link-local or metadata address, and what it asks for leaves through the egress rules or not at all:

1. The route filter, below: the worker fetches every request the browser routes through the platform's egress client, `fetchSafe`, and hands the answer to the browser. Nothing is left to `route.continue()`, which would let the browser resolve a name and connect by itself; Playwright never routes a redirect the browser follows on its own, so no answer handed on is a redirect.
2. The dead proxy and the removed transports (`constants.ts`, `transports.ts`). What Chromium sends by itself, which the route filter never sees (a speculation rule's prefetch or prerender, a preconnect, a shared worker's requests, a worker's WebSocket), goes to the context's proxy, `http://127.0.0.1:9`, the discard port of the browser's own host, where nothing answers, for every address, loopback included; a routed request never reaches it. A proxy carries no UDP, so an init script takes `RTCPeerConnection`, `webkitRTCPeerConnection` and `WebTransport` from every document, frames and popups included, before its scripts run; a worker keeps `WebTransport`, which Chromium refuses through a proxy.
3. The network: the service is on the `browser` network only, which is internal, with the worker as its one neighbour, which listens on nothing there. What the browser still does by itself (a name looked up ahead of a link) reaches no data service and has no route out.

**The route filter.** On every request of every page of the context (`index.ts`, `requests.ts`):

- the page's first navigation gets the document already fetched. A later navigation of the main frame, the page's own (a `location` change, a refresh), is fetched and checked as the document was, and followed: refused or failed, it fails the call at once with its code, `browser_blocked` for a blocked address;
- a navigation of a frame or of another page is aborted, and another page closed;
- a request but GET (a form's POST, a beacon) is aborted; for the main frame, the call fails with `browser_provider_error`, reason `not_get`;
- images, fonts, media and their text tracks, event streams and web app manifests are aborted: never requested;
- a WebSocket is closed before it opens;
- the rest goes through `fetchSafe`: http or https only, the scheme's own port only, the host resolved once and refused when `isBlockedAddress` says so, the connection pinned to the address checked, each of at most 5 redirects checked again, the body as sent (`identity`). The answer reaches the browser with its status and only `content-type`, `content-language`, `refresh` and CORS's headers: never a cookie, and never a 3xx the client did not follow. A refused or failed request is aborted, and the page goes on without it.

**The limits** (`constants.ts`). A page has 15 seconds, the document's fetch, the connection and the read included: past them, `browser_timeout`. The connection has 5 seconds: a service down, or busy past its two clients for that long, is `browser_unavailable`. A page sends 100 requests at most, the document and each redirect followed included; nothing more after that. An answer is 4 MiB at most (a document past it is `browser_too_large`, another answer is not handed on), and all of a page's 16 MiB: each request holds a whole answer's room until its size is known, so that three or four run at a time. The text and the links are the port's: 50,000 characters and 300 links.

**The read** (`reader.ts`). An init script defines a reader in every document, before the page's own scripts run. It keeps the built-ins it calls as they were, so that a page that replaces one changes nothing it answers, and `eval`, which Playwright's evaluation calls, cannot be replaced. It answers the body's text as a reader sees it (`innerText`), cut at 50,001 characters, and the first 300 distinct links whose href is http, https or `mailto:`, each with its text. The worker checks the answer's shape and bounds again, trims the text and cuts it at 50,000 characters, a surrogate pair kept whole, and collapses the spaces of each link's text. `finalUrl` is where the browser ended, when that is http or https and fits, else the document's.

**Vendor and terms.** None: Playwright (Apache-2.0) and Chromium run in our own container; no account and no key. The pages are public company websites; robots.txt is the caller's to check before it asks (gamma-en-065).

**Variables** (`deploy/.env.example`, read when the adapter starts; `config.ts`):

| Variable | |
|---|---|
| `PROVIDER_BROWSER` | `playwright` selects this adapter |
| `BROWSER_WS_URL` (`requires` names it) | the service's endpoint, a `ws:` or `wss:` URL: `ws://browser:3000/` in Compose. Not a secret, since the service is reached on the internal network only. Empty or not a ws URL, `create()` fails with `config_invalid`, naming the variable, never the value |

**Running the service locally.** The image is about 2 GB. On a laptop, run the server from the repository's own `playwright-core`, on a Chromium of its version already installed (`~/.cache/ms-playwright/chromium-1248` for 1.64.1; `pnpm exec playwright install chromium` downloads one): `node node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/cli.js run-server --port 3333 --host 127.0.0.1`, then `BROWSER_WS_URL=ws://127.0.0.1:3333/`. A local server has the first two fences and not the network: its dead proxy is the laptop's port 9, where nothing should listen, and a name the browser looks up by itself goes to the laptop's resolver. Never set `DEBUG=pw:*` for the client: Playwright's protocol log prints every URL and every page.

**Provider refs.** None: the adapter stores nothing, and the service keeps nothing between calls.

**Known differences.** Images, fonts and media never load: text drawn in an image, or a web font's icons, is not read. A page that needs a cookie, a login or its service worker renders without it. A navigation of the page's own that redirects shows the page at the URL it asked for, and its relative links resolve from there. A page has no WebRTC and no WebTransport, no WebSocket opens, and a shared worker's requests fail.

**Tests.** No test reaches a real site. They run on a site on 127.0.0.1 (`tests/site.ts`), with test names a resolver answers, let through by the adapter's test options, which only `APP_ENV=test` takes. `tests/contract.test.ts` runs the port's suite on the service, skipped while `BROWSER_WS_URL` is empty. Then, in every pipeline, since the document comes before the service:

- hosts that resolve to 10.0.0.1, 127.0.0.1, 169.254.169.254 and `::1`, and a redirect to each, `browser_blocked` with nothing sent there;
- the service down; a document not HTML, or past 4 MiB;
- a page's request bounds; `create()`'s refusals; the test options refused in production and development;
- a marker in every URL's path and query and in the pages' text, found in no output, error, span, log record or metric of a host's run (`tests/fixtures/marker-host.ts`).

`tests/render.test.ts` needs the service:

- a page whose text appears only after its script runs, read whole;
- no image, font or medium requested;
- what a page asks for from inside (a blocked address, a POST, a beacon, a WebSocket, a frame, a popup) never sent;
- 100 requests at most;
- a navigation of its own followed, and to a blocked address `browser_blocked` at once;
- a page past 15 seconds `browser_timeout`, its timer's requests stopping with its context;
- nothing past the route filter reaching a target on 127.0.0.1 off the test hosts, which records every connection, request, WebSocket opening and datagram: speculation rules' prefetch, prerender and preconnect; a shared worker's fetch and WebSocket, its script coming through the egress rules; a worker's WebSocket; STUN from the page, a frame, a `srcdoc` and a `data:` frame and two popups, none of which has WebRTC or WebTransport; and WebTransport from a page, a worker and a shared worker, refused through the context's proxy. That last one runs outside the adapter, on a page at `localhost`: Chromium's local network check would stop a routed page's first, so the proxy's part would not show.

`pnpm -F providers test:browser` runs both, against the local server above with `BROWSER_WS_URL` set.
