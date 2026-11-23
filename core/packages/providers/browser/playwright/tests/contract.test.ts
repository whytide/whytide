// The playwright adapter's tests (../README.md "Tests"), on a test site at 127.0.0.1 (site.ts) and
// test names that a resolver answers, never a real site. First the port's contract suite on the
// browser service at BROWSER_WS_URL, skipped while it is empty. Then what needs no service, since a
// page is fetched before the service is asked, and so runs in every pipeline: a host that resolves
// to a blocked address, and a redirect to one, browser_blocked with nothing sent there; the service
// down browser_unavailable; a document that is not HTML, or past 4 MiB, never reaching the service;
// a page's requests, 100 at most and 16 MiB of answers in all; BROWSER_WS_URL's refusals; the test options refused outside APP_ENV=test; and the marker, in every
// URL's path and query and in the pages' text, found in no error, log line or span of a host's run.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closedServiceUrl, namesResolver, recordRequests, startSite } from "./site.ts";

/** Made up for the run, so that no string in the repository is what the marker test looks for. */
const MARKER = `marker${randomBytes(12).toString("hex")}`;
const CONTRACT_TEXT = "Granite Orbit Works Team Mail";
/** An answer a little under 4 MiB: four of them fit a page's 16 MiB, a fifth does not. */
const CHUNK = Math.floor(3.9 * 1024 * 1024);
const site = await startSite({
  "/contract": {
    body: '<!doctype html><title>Granite</title><body>Granite Orbit Works <a href="/team">Team</a> <a href="mailto:hello@granite-orbit.example">Mail</a></body>',
  },
  "/plain": { body: "Granite Orbit Works", type: "text/plain" },
  "/big": { body: `<!doctype html><p>${"x".repeat(4 * 1024 * 1024)}</p>` },
  "/chunk": { body: "x".repeat(CHUNK), type: "text/javascript" },
  "/marker": {
    body: `<!doctype html><body><p>${MARKER} harbour</p><script src="/marker.js?q=${MARKER}"></script><a href="/${MARKER}?q=${MARKER}">${MARKER}</a></body>`,
  },
  "/marker.js": {
    body: `document.body.append("${MARKER} after the script");`,
    type: "text/javascript",
  },
});
after(() => site.close());
/** The names the tests resolve, each to a blocked address; anything else is not found. */
const NAMES = {
  "ten.example.test": ["10.0.0.1"],
  "loop.example.test": ["127.0.0.1"],
  "metadata.example.test": ["169.254.169.254"],
  "six.example.test": ["::1"],
};
const resolve = namesResolver(NAMES);
// The site's own port, given by name too: the port passes, the address still does not.
const testHosts = [site.host, `loop.example.test:${site.port}`];
const recorder = recordRequests();
const serviceUrl = process.env.BROWSER_WS_URL;

const { isAppError, parseHostList } = await import("@whytide/platform");
const { bindPort } = await import("../../../_pattern/index.ts");
const { contractSuite } = await import("../../../testing/index.ts");
const { browserCases } = await import("../../contract.ts");
const { browserPort } = await import("../../port.ts");
const { playwrightAdapter, playwrightBrowser } = await import("../index.ts");
const { PageRequests } = await import("../requests.ts");

const sent = () => recorder.sent(serviceUrl).length;
contractSuite(
  browserPort,
  {
    port: browserPort,
    name: playwrightAdapter.name,
    requires: playwrightAdapter.requires,
    create: () => playwrightBrowser(serviceUrl ?? "", { testHosts, resolve }),
  },
  browserCases({
    page: () => ({
      url: site.url("/redirect?to=/contract"),
      page: {
        finalUrl: site.url("/contract"),
        status: 200,
        text: CONTRACT_TEXT,
        links: [
          { href: site.url("/team"), text: "Team" },
          { href: "mailto:hello@granite-orbit.example", text: "Mail" },
        ],
      },
    }),
    requests: sent,
  }),
);

/** The adapter bound as the registry binds it, on the service at `url`. */
const adapterOn = (url: string) =>
  bindPort(browserPort, playwrightBrowser(url, { testHosts, resolve }), { adapter: "playwright" });
const fails = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], [code, details]);
  return true;
};
const blocked = (reason: string) => fails("browser_blocked", { reason });

test("a host that resolves to 10.0.0.1, 127.0.0.1, 169.254.169.254 or ::1 is browser_blocked, and nothing is sent, there or to the service", async () => {
  const down = await closedServiceUrl();
  const browser = adapterOn(down);
  const urls = [
    "http://ten.example.test/",
    `http://loop.example.test:${site.port}/contract`,
    "http://metadata.example.test/latest/meta-data/",
    "http://six.example.test/",
  ];
  const before = [recorder.sent().length, site.received.length];
  for (const url of urls) {
    await assert.rejects(browser.renderPage({ url }), blocked("egress_blocked_address"), url);
  }
  for (const url of ["file:///etc/passwd", "ftp://ftp.example.test/pub/notes.txt"]) {
    await assert.rejects(browser.renderPage({ url }), blocked("egress_bad_scheme"), url);
  }
  assert.deepEqual([recorder.sent().length, site.received.length], before, "nothing was sent");
});

test("a redirect to a blocked address, or off http and https, is browser_blocked: the redirect is the one request sent", async () => {
  const browser = adapterOn(await closedServiceUrl());
  const targets = [
    ["http://ten.example.test/", "egress_blocked_address"],
    [`http://loop.example.test:${site.port}/contract`, "egress_blocked_address"],
    ["http://metadata.example.test/latest/meta-data/", "egress_blocked_address"],
    ["http://six.example.test/", "egress_blocked_address"],
    ["http://169.254.169.254/latest/meta-data/", "egress_blocked_address"],
    ["file:///etc/passwd", "egress_bad_scheme"],
  ] as const;
  for (const [target, reason] of targets) {
    const before = [recorder.sent().length, site.received.length];
    const url = site.url(`/redirect?to=${encodeURIComponent(target)}`);
    await assert.rejects(browser.renderPage({ url }), blocked(reason), target);
    assert.deepEqual(recorder.sent().slice(before[0]), [site.host], target);
    assert.deepEqual(
      site.received.slice(before[1]),
      [`GET /redirect?to=${encodeURIComponent(target)}`],
      target,
    );
  }
});

test("the service down is browser_unavailable, after the document; a document not HTML, or past 4 MiB, never reaches the service", async () => {
  const down = await closedServiceUrl();
  const browser = adapterOn(down);
  await assert.rejects(
    browser.renderPage({ url: site.url("/contract") }),
    fails("browser_unavailable", undefined),
  );
  const before = recorder.sent(down).length;
  const all = recorder.sent().length;
  await assert.rejects(
    browser.renderPage({ url: site.url("/plain") }),
    fails("browser_provider_error", { reason: "not_html" }),
  );
  await assert.rejects(
    browser.renderPage({ url: site.url("/big") }),
    fails("browser_too_large", undefined),
  );
  assert.equal(recorder.sent(down).length - before, 2, "the two documents");
  assert.equal(recorder.sent().length - all, 2, "and no connection to the service");
});

test("a page's requests: 100 at most, 16 MiB of answers in all, and none sent once the call is over", async () => {
  const egress = { lists: { allowHosts: parseHostList(site.host) } };
  const from = site.received.length;
  const many = new PageRequests(egress, 15_000);
  await Promise.all(Array.from({ length: 100 }, () => many.fetch(site.url("/plain"))));
  await assert.rejects(
    many.fetch(site.url("/plain")),
    fails("browser_provider_error", { reason: "too_many_requests" }),
  );
  const large = new PageRequests(egress, 15_000);
  const answers = await Promise.allSettled(
    Array.from({ length: 5 }, () => large.fetch(site.url("/chunk"))),
  );
  assert.deepEqual(
    answers.map((answer) =>
      answer.status === "fulfilled" ? answer.value.body.length : String(answer.reason),
    ),
    [CHUNK, CHUNK, CHUNK, CHUNK, "AppError: browser_too_large"],
  );
  large.close();
  await assert.rejects(
    large.fetch(site.url("/chunk")),
    fails("browser_provider_error", { reason: "render_ended" }),
  );
  assert.equal(site.received.length - from, 105, "neither the 101st nor the one after the end");
});

test("create() refuses BROWSER_WS_URL empty, or not a ws: or wss: URL, naming the variable, never the value", () => {
  const startedOn = (value: string) => {
    const saved = process.env.BROWSER_WS_URL;
    process.env.BROWSER_WS_URL = value;
    try {
      playwrightAdapter.create();
      return "created";
    } catch (error) {
      assert.ok(isAppError(error) && error.code === "config_invalid", String(error));
      return (error.details as { variables: string[] }).variables.join();
    } finally {
      if (saved === undefined) delete process.env.BROWSER_WS_URL;
      else process.env.BROWSER_WS_URL = saved;
    }
  };
  const values = ["", `http://browser.${MARKER}.test:3000/`, MARKER, "ws://browser:3000/"];
  assert.deepEqual(values.map(startedOn), [
    "BROWSER_WS_URL: required by the playwright adapter",
    "BROWSER_WS_URL: a ws: or wss: URL",
    "BROWSER_WS_URL: a ws: or wss: URL",
    "created",
  ]);
});

test("the test hosts and the test resolver are refused outside APP_ENV=test, with adapter_invalid", async () => {
  const adapter = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = [
    `const { playwrightBrowser } = await import(${adapter});`,
    "const outcome = (options) => { try { playwrightBrowser('ws://127.0.0.1:9/', options); return 'created'; } catch (error) { return error.code; } };",
    "const resolve = async () => ['127.0.0.1'];",
    "console.log([outcome({ testHosts: ['127.0.0.1:8080'] }), outcome({ resolve }), outcome(undefined)].join(' '));",
  ].join("\n");
  const runAs = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV}: ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "production", "development"].map(runAs)), [
    "test: created created created",
    "production: adapter_invalid adapter_invalid created",
    "development: adapter_invalid adapter_invalid created",
  ]);
});

type Export = { readonly url: string; readonly body: string };
type Traces = { resourceSpans: { scopeSpans: { spans: { name: string }[] }[] }[] };

/** An OTLP receiver on 127.0.0.1 taking http/json: every export, as sent. */
async function startReceiver() {
  const received: Export[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({ url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

const spanNames = (received: readonly Export[]) =>
  received
    .filter((exported) => exported.url === "/v1/traces")
    .flatMap((exported) => (JSON.parse(exported.body) as Traces).resourceSpans)
    .flatMap(({ scopeSpans }) => scopeSpans.flatMap(({ spans }) => spans.map(({ name }) => name)));

test("the marker, in every URL's path and query and in the pages' text, is in no line, error, span, log record or metric of a host's run", async () => {
  const receiver = await startReceiver();
  try {
    const query = `?ref=${MARKER}`;
    const urls = [
      site.url(`/marker${query}`),
      site.url(`/redirect?to=${encodeURIComponent(`/marker${query}`)}`),
      `http://metadata.example.test/${MARKER}${query}`,
      site.url(`/redirect?to=${encodeURIComponent(`http://ten.example.test/${MARKER}`)}`),
      site.url(`/plain${query}`),
      site.url(`/${MARKER}${query}`),
      `file:///${MARKER}`,
    ];
    const host = fileURLToPath(new URL("./fixtures/marker-host.ts", import.meta.url));
    const {
      OTEL_EXPORTER_OTLP_ENDPOINT: _endpoint,
      NODE_TEST_CONTEXT: _context,
      ...env
    } = process.env;
    const child = spawn(process.execPath, [host], {
      env: {
        ...env,
        APP_ENV: "test",
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        MARKER_SERVICE: serviceUrl ?? (await closedServiceUrl()),
        MARKER_HOSTS: JSON.stringify(testHosts),
        MARKER_NAMES: JSON.stringify(NAMES),
        MARKER_URLS: JSON.stringify(urls),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((done) => child.on("close", done));
    assert.equal(code, 0, output);
    const report = output.split("\n").find((line) => line.startsWith('{"failures":'));
    const { failures, rendered } = JSON.parse(report ?? "{}") as Record<string, number>;
    // With the service, the marker page, by itself and through the redirect, and the 404 page
    // render; without it, every call fails.
    assert.equal((failures ?? 0) + (rendered ?? 0), urls.length, output);
    assert.equal(rendered, serviceUrl === undefined ? 0 : 3, output);
    const names = spanNames(receiver.received);
    assert.ok(names.includes("egress.fetch"), `the egress client's spans: ${names.join()}`);
    assert.ok(names.includes("browser.render"), "the caller's spans");
    const exported = (url: string, text: string) =>
      receiver.received.some((e) => e.url === url && e.body.includes(text));
    assert.ok(exported("/v1/logs", "page render failed"), "the failures' log records");
    assert.ok(exported("/v1/metrics", "providers.calls"), "the calls' metric");
    const seen = [output, ...receiver.received.map((e) => e.body)];
    assert.deepEqual(
      seen.filter((text) => text.includes(MARKER)),
      [],
    );
  } finally {
    await receiver.close();
  }
});
