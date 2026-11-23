// The playwright adapter against the browser service at BROWSER_WS_URL (../README.md "Tests"), run by
// `pnpm -F providers test:browser`; each test is skipped while BROWSER_WS_URL is empty. On a test
// site at 127.0.0.1 (site.ts), with test names a resolver answers: a page whose text appears only
// after its script runs, read whole; images, fonts and media never requested; what a page asks of a
// blocked address, a POST, a WebSocket, a frame and a popup never sent; more than 100 requests never
// sent; a navigation of the page's own followed, and to a blocked address browser_blocked at once;
// a page past 15 seconds browser_timeout, its context closed with it; and what Chromium would send
// past the route filter (speculation rules, a shared worker, a worker's WebSocket, WebRTC,
// WebTransport) never reaching a target on 127.0.0.1 off the test hosts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { namesResolver, recordRequests, startSite, startTarget } from "./site.ts";

const APP = `
const root = document.getElementById("root");
root.innerHTML = '<h1>Copper Harbor Labs</h1><p id="line">Loading</p>' +
  '<a href="/about">About   us</a> <a href="https://www.linkedin.com/company/copper-harbor-labs">LinkedIn</a> ' +
  '<a href="mailto:hello@copper-harbor.example">Write to us</a> <a href="javascript:void(0)">Menu</a> ' +
  '<a href="/about">About again</a><svg><a href="/svg-link"><text>SVG</text></a></svg>';
fetch("/data.json").then((answer) => answer.json()).then((data) => {
  document.getElementById("line").textContent = data.line;
});`;
const MEDIA = `<!doctype html><html><head><style>
@font-face { font-family: Harbour; src: url(/m/harbour.woff2) format("woff2"); }
body { font-family: Harbour, sans-serif; background: url(/m/background.png); }
</style><link rel="icon" href="/m/favicon.ico"><link rel="preload" href="/m/preload.woff2" as="font" crossorigin></head>
<body><p>Media page</p><img src="/m/photo.png" alt=""><picture><source srcset="/m/photo.webp"><img src="/m/photo-2.png" alt=""></picture>
<video src="/m/clip.mp4" autoplay muted></video><audio src="/m/sound.mp3" autoplay></audio>
<script>new Image().src = "/m/script.png";</script></body></html>`;
const INSIDE = `<!doctype html><body><p>Inside page</p><iframe src="/frame"></iframe><script>
fetch("http://metadata.example.test/latest/meta-data/").catch(() => {});
fetch("http://10.0.0.1/").catch(() => {});
fetch("/posted", { method: "POST", body: "x" }).catch(() => {});
navigator.sendBeacon("/beacon", "x");
try { new WebSocket(location.origin.replace("http", "ws") + "/socket"); } catch {}
window.open("/popup");
const tracker = document.createElement("script");
tracker.src = "http://ten.example.test/tracker.js";
document.head.append(tracker);
</script></body>`;

// A target off the test hosts, and the pages that try to reach it past the route filter. Each one
// waits on /held, so that the page has its 3 seconds to settle before it is read.
const target = await startTarget();
after(() => target.close());
const TARGET_SOCKET = target.origin.replace("http", "ws");
const HOLD = 'fetch("/held").catch(() => {});';
const SPECULATION = `<!doctype html><html><head><link rel="preconnect" href="${target.origin}/"></head>
<body><p>Speculation rules</p><script type="speculationrules">
{"prefetch": [{"source": "list", "urls": ["${target.origin}/prefetched"], "eagerness": "immediate"}],
 "prerender": [{"source": "list", "urls": ["${target.origin}/prerendered"], "eagerness": "immediate"}]}
</script><script>document.body.append(HTMLScriptElement.supports("speculationrules") ? " Rules on" : " Rules off"); ${HOLD}</script></body></html>`;
const SHARED_WORKER = `onconnect = (event) => {
  event.ports[0].postMessage("Shared worker ran");
  fetch("${target.origin}/from-shared-worker").catch(() => {});
  try { new WebSocket("${TARGET_SOCKET}/shared-worker-socket"); } catch {}
};`;
/** A script that starts a worker of `code`, from a blob, and adds what it posts to the page's text. */
const startWorker = (kind: "Worker" | "SharedWorker", code: string) => {
  const source = `URL.createObjectURL(new Blob([${JSON.stringify(code)}], { type: "text/javascript" }))`;
  const port = kind === "Worker" ? "worker" : "worker.port";
  return `{ const worker = new ${kind}(${source}); ${port}.onmessage = (message) => document.body.append(" " + message.data); }`;
};
const SHARED = `<!doctype html><body><p>Shared workers</p><script>
${startWorker("SharedWorker", SHARED_WORKER)}
new SharedWorker("/shared-worker.js").port.onmessage = () => document.body.append(" From its URL");
${HOLD}</script></body>`;
const WORKER_SOCKET = `<!doctype html><body><p>A worker's socket</p><script>
${startWorker("Worker", `postMessage("Worker ran"); try { new WebSocket("${TARGET_SOCKET}/worker-socket"); } catch {}`)}
${HOLD}</script></body>`;
// Each document, frames and popups included, tells which of WebRTC and WebTransport it still has,
// and makes a peer connection that asks the target's UDP port for its address, if it can.
const TRANSPORTS = '["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]';
const STUN = `{ iceServers: [{ urls: "stun:127.0.0.1:${target.udpPort}" }] }`;
const PEER = (scope: string) =>
  `try { const peer = new ${scope}.RTCPeerConnection(${STUN}); peer.createDataChannel("x"); peer.createOffer().then((offer) => peer.setLocalDescription(offer)); } catch {}`;
const DATA_FRAME = `<script>parent.postMessage("data: " + (${TRANSPORTS}.filter((name) => self[name] !== undefined).join(" ") || "none"), "*"); ${PEER("self")}</script>`;
const PEERS = `<!doctype html><body><p>Peer connections</p><script>
function check(where, scope) {
  document.body.append(" " + where + ": " + (${TRANSPORTS}.filter((name) => scope[name] !== undefined).join(" ") || "none"));
  ${PEER("scope")}
}
addEventListener("message", (event) => document.body.append(" " + event.data));
check("page", window);
const frame = document.createElement("iframe");
document.body.append(frame);
check("frame", frame.contentWindow);
check("popup", window.open("", "popup", ""));
check("opened", document.open("", "opened", ""));
${HOLD}</script>
<iframe srcdoc="<script>parent.check('srcdoc', window)</script>"></iframe>
<iframe src="data:text/html,${encodeURIComponent(DATA_FRAME)}"></iframe></body>`;
// WebTransport to the target's UDP port from a page, a worker and a shared worker, each telling how
// it ended: `<where>:opened`, `<where>:failed` or `<where>:threw`.
const OPEN_TRANSPORT = (where: string, post: string) =>
  `try { new WebTransport("https://127.0.0.1:${target.udpPort}/", { serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(32) }] }).ready.then(() => ${post}("${where}:opened"), () => ${post}("${where}:failed")); } catch { ${post}("${where}:threw"); }`;
const TRANSPORT_ENDS = ["page:failed", "shared:failed", "worker:failed"];
const TRANSPORT = `<!doctype html><body><p>WebTransport</p><script>
${OPEN_TRANSPORT("page", '((word) => document.body.append(" " + word))')}
${startWorker("Worker", OPEN_TRANSPORT("worker", "postMessage"))}
${startWorker("SharedWorker", `onconnect = (event) => { ${OPEN_TRANSPORT("shared", "((word) => event.ports[0].postMessage(word))")} };`)}
</script></body>`;

const site = await startSite({
  "/js-only": {
    body: '<!doctype html><html><head><title>Copper Harbor</title><script src="/app.js" defer></script></head><body><main id="root"></main><noscript>Turn on JavaScript to see this page.</noscript></body></html>',
  },
  "/app.js": { body: APP, type: "text/javascript" },
  "/data.json": {
    body: '{"line":"Synthetic harbours, built after the script ran."}',
    type: "application/json",
  },
  "/media": { body: MEDIA },
  "/inside": { body: INSIDE },
  "/many": {
    body: '<!doctype html><body><p>Many requests</p><script>for (let n = 0; n < 150; n += 1) fetch("/n/" + n).catch(() => {});</script></body>',
  },
  "/leaving": {
    body: '<!doctype html><body><p>Leaving</p><script>location.href = "http://metadata.example.test/latest/meta-data/";</script></body>',
  },
  "/hop": {
    body: '<!doctype html><body><p>Hop</p><script>location.href = "/landing";</script></body>',
  },
  "/landing": { body: "<!doctype html><body><p>Landing page</p></body>" },
  "/slow": {
    body: '<!doctype html><body><p>Slow page</p><script>setInterval(() => { fetch("/tick").catch(() => {}); }, 500);</script><script src="/held"></script></body>',
  },
  "/speculation": { body: SPECULATION },
  "/shared": { body: SHARED },
  "/shared-worker.js": { body: SHARED_WORKER, type: "text/javascript" },
  "/worker-socket": { body: WORKER_SOCKET },
  "/peers": { body: PEERS },
  "/transport": { body: TRANSPORT },
});
after(() => site.close());
const recorder = recordRequests();
const serviceUrl = process.env.BROWSER_WS_URL ?? "";
const skip = serviceUrl === "" ? "skipped: BROWSER_WS_URL is not set" : false;

const { isAppError } = await import("@whytide/platform");
const { bindPort } = await import("../../../_pattern/index.ts");
const { browserPort } = await import("../../port.ts");
const { playwrightBrowser } = await import("../index.ts");

const browser = bindPort(
  browserPort,
  playwrightBrowser(serviceUrl, {
    testHosts: [site.host],
    resolve: namesResolver({
      "ten.example.test": ["10.0.0.1"],
      "metadata.example.test": ["169.254.169.254"],
    }),
  }),
  { adapter: "playwright" },
);
const fails = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], [code, details]);
  return true;
};
/** What the site received since `from`, `<method> <path>`. */
const since = (from: number) => site.received.slice(from);
/** The page's text, its spaces collapsed. */
const words = (text: string) => text.replace(/\s+/g, " ").trim();
/** What reached the target since `from`, once what was on its way has landed. */
const reached = async (from: number) => {
  await sleep(500);
  return target.reached.slice(from);
};

test("a page whose text appears only after its script runs is read whole: its text, and its links absolute, in order, each once", {
  skip,
}, async () => {
  const from = site.received.length;
  const page = await browser.renderPage({ url: site.url("/redirect?to=/js-only") });
  assert.equal(page.finalUrl, site.url("/js-only"));
  assert.equal(page.status, 200);
  assert.match(page.text, /^Copper Harbor Labs\s+Synthetic harbours, built after the script ran\./);
  assert.doesNotMatch(page.text, /Loading|Turn on JavaScript/);
  assert.deepEqual(page.links, [
    { href: site.url("/about"), text: "About us" },
    { href: "https://www.linkedin.com/company/copper-harbor-labs", text: "LinkedIn" },
    { href: "mailto:hello@copper-harbor.example", text: "Write to us" },
  ]);
  assert.deepEqual(since(from), [
    "GET /redirect?to=/js-only",
    "GET /js-only",
    "GET /app.js",
    "GET /data.json",
  ]);
});

test("images, fonts and media are never requested", { skip }, async () => {
  const from = site.received.length;
  const page = await browser.renderPage({ url: site.url("/media") });
  assert.equal(page.text, "Media page");
  assert.deepEqual(since(from), ["GET /media"], "nothing under /m/");
});

test("what a page asks for from inside is never sent: a blocked address, a POST, a beacon, a WebSocket, a frame and a popup; the page still renders", {
  skip,
}, async () => {
  const from = site.received.length;
  const sentBefore = recorder.sent(serviceUrl).length;
  const page = await browser.renderPage({ url: site.url("/inside") });
  assert.equal(page.text, "Inside page");
  assert.deepEqual(since(from), ["GET /inside"]);
  assert.deepEqual(recorder.sent(serviceUrl).slice(sentBefore), [site.host], "the document only");
});

test("a page sends at most 100 requests, its document included", { skip }, async () => {
  const from = site.received.length;
  const page = await browser.renderPage({ url: site.url("/many") });
  assert.equal(page.text, "Many requests");
  const received = since(from);
  assert.equal(received[0], "GET /many");
  assert.equal(received.length, 100, "the document and 99 of the page's 150");
});

test("a navigation of the page's own is followed, as a redirect is: the page it lands on is read", {
  skip,
}, async () => {
  const from = site.received.length;
  const page = await browser.renderPage({ url: site.url("/hop") });
  assert.deepEqual([page.finalUrl, page.text], [site.url("/landing"), "Landing page"]);
  assert.deepEqual(since(from), ["GET /hop", "GET /landing"]);
});

test("a navigation of the page's own to a blocked address is browser_blocked at once, and nothing is sent there", {
  skip,
}, async () => {
  const sentBefore = recorder.sent(serviceUrl).length;
  const started = performance.now();
  await assert.rejects(
    browser.renderPage({ url: site.url("/leaving") }),
    fails("browser_blocked", { reason: "egress_blocked_address" }),
  );
  assert.ok(performance.now() - started < 5_000, "without waiting for the deadline");
  assert.deepEqual(recorder.sent(serviceUrl).slice(sentBefore), [site.host], "the document only");
});

test("a page past 15 seconds is browser_timeout, and its context is closed: its timer's requests stop", {
  skip,
  timeout: 30_000,
}, async () => {
  const ticks = () => site.received.filter((request) => request === "GET /tick").length;
  const started = performance.now();
  await assert.rejects(browser.renderPage({ url: site.url("/slow") }), fails("browser_timeout"));
  const took = performance.now() - started;
  assert.ok(took >= 15_000 && took < 17_000, `${Math.round(took)} ms`);
  assert.ok(ticks() > 10, `the page's timer ran while it waited: ${ticks()}`);
  await sleep(500); // a request already in flight lands
  const closed = ticks();
  await sleep(1_500);
  assert.equal(ticks(), closed, "no request after the context closed");
});

test("speculation rules, which Chromium fetches by itself, never reach an address the route filter refuses: their prefetch, prerender and preconnect go to the dead proxy", {
  skip,
}, async () => {
  const from = target.reached.length;
  const page = await browser.renderPage({ url: site.url("/speculation") });
  assert.equal(words(page.text), "Speculation rules Rules on");
  assert.deepEqual(await reached(from), []);
});

test("a shared worker reaches nothing past the route filter: its script comes through the egress rules, and its fetch and its WebSocket, which the filter never sees, fail at the dead proxy", {
  skip,
}, async () => {
  const from = target.reached.length;
  const fromSite = site.received.length;
  const sentBefore = recorder.sent(serviceUrl).length;
  const page = await browser.renderPage({ url: site.url("/shared") });
  const text = words(page.text);
  assert.ok(text.includes("Shared worker ran") && text.includes("From its URL"), text);
  assert.deepEqual(await reached(from), []);
  const received = since(fromSite);
  assert.deepEqual(received.toSorted(), ["GET /held", "GET /shared", "GET /shared-worker.js"]);
  assert.deepEqual(
    recorder.sent(serviceUrl).slice(sentBefore),
    received.map(() => site.host),
  );
});

test("a worker's WebSocket, which Playwright never routes, reaches nothing: it fails at the dead proxy", {
  skip,
}, async () => {
  const from = target.reached.length;
  const page = await browser.renderPage({ url: site.url("/worker-socket") });
  assert.equal(words(page.text), "A worker's socket Worker ran");
  assert.deepEqual(await reached(from), []);
});

test("no document has WebRTC or WebTransport, frames and popups included: no STUN request reaches the target", {
  skip,
}, async () => {
  const from = target.reached.length;
  const page = await browser.renderPage({ url: site.url("/peers") });
  assert.deepEqual(await reached(from), []);
  const text = words(page.text);
  for (const where of ["page", "frame", "popup", "opened", "srcdoc", "data"]) {
    assert.ok(text.includes(` ${where}: none`), `${where} in: ${text}`);
  }
});

test("Chromium refuses a WebTransport through the context's proxy: from a page, a worker and a shared worker, no packet reaches the target", {
  skip,
}, async () => {
  // Not through the adapter, whose pages Chromium counts as public, and whose requests to loopback
  // its local network check refuses first: the context as the adapter makes it, no transport taken
  // away, on a page at localhost, which the proxy lets through for this test only.
  const { chromium } = await import("playwright-core");
  const { CONTEXT } = await import("../constants.ts");
  const service = await chromium.connect(serviceUrl);
  try {
    const proxy = CONTEXT.proxy && {
      ...CONTEXT.proxy,
      bypass: `${CONTEXT.proxy.bypass},localhost`,
    };
    const context = await service.newContext({ ...CONTEXT, proxy });
    const tab = await context.newPage();
    const from = target.reached.length;
    await tab.goto(`http://localhost:${site.port}/transport`);
    const ended = 'document.body.innerText.split(":").length === 4';
    await tab.waitForFunction(ended, undefined, { timeout: 5_000 }).catch(() => undefined);
    const [title, ...ends] = words(String(await tab.evaluate("document.body.innerText"))).split(
      " ",
    );
    assert.deepEqual([title, ends.toSorted()], ["WebTransport", TRANSPORT_ENDS]);
    assert.deepEqual(await reached(from), []);
  } finally {
    await service.close();
  }
});
