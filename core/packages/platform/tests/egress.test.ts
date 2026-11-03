// The end-to-end test of the egress client (alpha-p1-065): fetchSafe against a local HTTP server
// with redirect, slow and large routes, a raw TCP one, and a stub DNS. The servers listen on
// 127.0.0.1, a blocked address, so they are reached as local test servers through the allow-list
// (allowsBlockedAddress) and stand in for public sites; the stub resolver answers for the public
// and private names, and a spy in place of request() for a site nothing may reach. The defaults are
// set before the import, and spans go to an in-memory exporter; a production child host with
// telemetry exports to a local collector.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import nodeDns from "node:dns";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { trace } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";
import { type AppError, httpStatus, isAppError } from "../errors/index.ts";

process.env.EGRESS_DEFAULT_MAX_BYTES = "1024";
process.env.EGRESS_DEFAULT_TIMEOUT_MS = "500";
process.env.EGRESS_DENY_HOSTS = "operator-denied.test"; // a caller's denyHosts adds to it
delete process.env.EGRESS_ALLOW_HOSTS;
const spans = new tracing.InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new tracing.BasicTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(spans)] }),
);
const { fetchSafe, parseHostList, readFetchSafeConfig } = await import("../http/index.ts");
type Resolver = import("../http/index.ts").Resolver;

const attempts: string[] = []; // every TCP connection attempt of this process, address:port
const offLoopback = new Set<string>(); // the address of each attempt not to loopback, never reset
// Multicast, of the block for documentation: the rules leave it open because TCP cannot connect to
// it, and the system refuses such a connect before anything is sent.
const unconnectable = "233.252.0.1";
diagnostics.subscribe("net.client.socket", (message) => {
  const { socket } = message as { socket: net.Socket };
  socket.on("connectionAttempt", (address: string, to: number) => {
    attempts.push(`${address}:${to}`);
    if (address !== "127.0.0.1" && address !== "::1") offLoopback.add(address);
  });
});
// Every request of this file goes to loopback, or to the one address no TCP connect reaches: any
// other pinned address stops here, before a socket exists, so a regression sends nothing.
for (const module of [http, https]) {
  const request = module.request as (...args: unknown[]) => http.ClientRequest;
  const guarded = (given: https.RequestOptions, ...rest: unknown[]) => {
    given.lookup?.("", { all: true }, (_error, found) => {
      const addresses = (found as unknown as { address: string }[]).map(({ address }) => address);
      for (const address of addresses) {
        if (!["127.0.0.1", "::1", unconnectable].includes(address)) {
          offLoopback.add(address);
          throw Object.assign(new Error("off the machine"), { code: "ESTOPPED" });
        }
      }
    });
    return request(given, ...rest);
  };
  Object.assign(module, { request: guarded });
}
const seen: { path: string; method?: string; headers: http.IncomingHttpHeaders }[] = [];
let stalled: Promise<unknown> | undefined; // the close of the last stalled connection
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://server.test");
  seen.push({ path: url.pathname, method: request.method, headers: request.headers });
  const [, route, hop] = url.pathname.split("/");
  if (route === "hop" && Number(hop) > 0) {
    response.writeHead(302, { location: `/hop/${Number(hop) - 1}${url.search}` }).end();
  } else if (route === "hop") {
    response.writeHead(200, { "content-type": "text/plain" }).end("landed");
  } else if (route === "to") {
    response.writeHead(302, { location: url.searchParams.get("url") ?? "" }).end();
  } else if (route === "moved") {
    response.writeHead(301, { location: url.searchParams.get("url") ?? "" }).end();
  } else if (route === "large") {
    response.writeHead(200, { "content-length": 2048 }).end(Buffer.alloc(2048));
  } else if (route === "chunked") {
    response.writeHead(200);
    for (let i = 0; i < 4; i += 1) response.write(Buffer.alloc(512));
    response.end();
  } else if (route === "hints") {
    // Sixteen 103 Early Hints heads of 8 KiB, 128 KiB on the wire, and no response after them.
    for (let i = 0; i < 16; i += 1) response.writeEarlyHints({ link: `<${"/a".repeat(4096)}>` });
  } else {
    stalled = once(request.socket, "close");
    const declared = url.searchParams.get("declare"); // a Content-Length, never met
    response.writeHead(200, declared ? { "content-length": declared } : {}).write("stalls");
  }
});
const port = await listen(server);
// A raw server: a 101 upgrade answer, 128 KiB of blank lines and no status line, blank lines up to
// the wire bound of maxBytes 1024 (2 × 1024 + 64 KiB) and a 302 past it, a body with no length that
// only the close ends (left open, reset once written, or ended by a clean close), a 302 with a
// malformed chunk in the read that brings its head, a whole body with more bytes in the same write
// (past its length, or past its last chunk), or a body in one-byte chunks as long as the path says
// (six bytes on the wire for each byte of body).
const raw = net.createServer((socket) => {
  socket.on("error", () => {}); // the client may close first
  socket.once("data", (request) => {
    const path = /^GET \/(\S*) /.exec(request.toString())?.[1];
    if (path === "upgrade") {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n",
      );
    } else if (path === "blank") {
      socket.write("\r\n".repeat(65_536));
    } else if (path === "crossing") {
      socket.write(`${"\r\n".repeat(33_792)}HTTP/1.1 302 Found\r\nlocation: /0\r\n\r\n`);
    } else if (path === "open") {
      socket.write("HTTP/1.1 200 OK\r\n\r\nfirst half"); // and the connection stays open
    } else if (path === "reset") {
      socket.write("HTTP/1.1 200 OK\r\n\r\npartial", () => socket.resetAndDestroy());
    } else if (path === "closed") {
      socket.end("HTTP/1.1 200 OK\r\n\r\nwhole");
    } else if (path === "garbled") {
      socket.end("HTTP/1.1 302 Found\r\nlocation: /0\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n");
    } else if (path === "extra") {
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhelloworld");
    } else if (path === "chunked-extra") {
      socket.end(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\nworld",
      );
    } else {
      const chunks = "1\r\nA\r\n".repeat(Number(path));
      socket.end(`HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n${chunks}0\r\n\r\n`);
    }
  });
});
const rawPort = await listen(raw);
const spare = http.createServer();
const closedPort = await listen(spare); // closed below: a connect there is refused
spare.close();
const base = `http://127.0.0.1:${port}`;
const lists = {
  allowHosts: parseHostList(
    `127.0.0.1:${port}, 127.0.0.1:${rawPort}, named.test:${port}, rebind.test:${port}`,
  ),
  denyHosts: parseHostList("denied.test"),
};
const dns: Record<string, string[]> = {
  "private.test": ["10.0.0.5"],
  "mixed.test": ["203.0.113.7", "127.0.0.1"],
  "mapped.test": ["::ffff:7f00:1"],
  "garbage.test": ["not-an-address"],
  "named.test": ["127.0.0.1"],
  "internal.test": ["10.0.0.2"],
};
const asked: string[] = [];
const stub: Resolver = async (host) => {
  asked.push(host);
  const answer = dns[host];
  if (answer) return answer;
  throw Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" });
};
const options = { maxRedirects: 3, lists, resolve: stub };
const deadline = { timeout: 10_000 }; // a test that waits on a deadline fails rather than hangs
const spawned = { timeout: 30_000 }; // a child host starts telemetry before it fetches

test.after(() => {
  server.closeAllConnections();
  server.close();
  raw.close();
});
// The record, read once every test has run; the guard above, not this, keeps a packet on the
// machine. Any address off loopback a request was pinned to (and the guard stopped) or a connection
// was attempted to fails the run, but the one address no TCP connect reaches.
test.after(() => {
  const elsewhere = [...offLoopback].filter((address) => address !== unconnectable);
  assert.deepEqual(elsewhere, []);
});

test("the happy path through the allow-list: a GET, the bytes, relative redirects followed", async () => {
  seen.length = 0;
  // The file's first calls, which a busy machine may not make within the 500 ms default.
  const patient = { ...options, timeoutMs: 5_000 };
  const response = await fetchSafe(`${base}/hop/2?q=1`, { ...patient, accept: "text/plain" });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/plain");
  assert.ok(Buffer.isBuffer(response.body) && response.body.toString() === "landed");
  assert.equal(response.finalUrl, `${base}/hop/0?q=1`);
  assert.equal(response.hops, 2);
  assert.deepEqual(
    seen.map(({ method, path }) => `${method} ${path}`),
    ["GET /hop/2", "GET /hop/1", "GET /hop/0"],
  );
  assert.equal(seen[0]?.headers.host, `127.0.0.1:${port}`);
  assert.equal(seen[0]?.headers.accept, "text/plain");
  assert.equal(seen[0]?.headers["accept-encoding"], "identity");
  // localhost through the default resolver, loopback without asking DNS: allow-listed, a local
  // test server may be loopback.
  const local = { allowHosts: parseHostList(`localhost:${port}`) };
  const viaName = await fetchSafe(`http://localhost:${port}/hop/0`, {
    maxRedirects: 0,
    timeoutMs: 5_000,
    lists: local,
  });
  assert.equal(viaName.body.toString(), "landed");
});

test("refuses a host that resolves to a private address, and each URL the rules refuse", async () => {
  seen.length = 0;
  asked.length = 0;
  for (const host of ["private.test", "mixed.test", "mapped.test", "garbage.test"]) {
    await refusal(fetchSafe(`http://${host}/`, options), "egress_blocked_address");
  }
  // An allow-listed name opened its port, not an address: what it resolves to is still checked.
  await refusal(fetchSafe(`http://named.test:${port}/hop/0`, options), "egress_blocked_address");
  const rules: [url: string, code: string][] = [
    ["http://169.254.169.254/latest/meta-data", "egress_blocked_address"],
    ["http://[::1]/", "egress_blocked_address"],
    ["http://localhost/", "egress_blocked_address"],
    ["ftp://example.com/", "egress_bad_scheme"],
    ["http://user:pass@example.com/", "egress_credentials_in_url"],
    ["http://denied.test/", "egress_denied_host"],
    ["http://operator-denied.test/", "egress_denied_host"],
    ["http://example.com:8443/", "egress_port_not_allowed"],
    ["not a url", "egress_invalid_url"],
  ];
  for (const [url, code] of rules) await refusal(fetchSafe(url, options), code);
  assert.deepEqual(asked, [
    "private.test",
    "mixed.test",
    "mapped.test",
    "garbage.test",
    "named.test",
  ]);
  const unknown = await refusal(fetchSafe("http://unknown.test/", options), "egress_dns_failed");
  assert.deepEqual(unknown.details, { reason: "ENOTFOUND" });
  const none = { ...options, resolve: async () => [] };
  await refusal(fetchSafe("http://empty.test/", none), "egress_dns_failed");
  assert.deepEqual(seen, []);
});

test("each range added since 060: refused as a literal and as a resolved address", async () => {
  // A spy in place of request(): an address let through would stop there, never connect.
  const stop = () => {
    throw Object.assign(new Error("stopped before connecting"), { code: "ESTOPPED" });
  };
  // Azure's wireserver, Oracle Cloud Classic's metadata, benchmarking in both families, 240/4, and
  // the metadata service, 169.254.169.254, in its IPv4-translated form.
  const addresses = [
    "168.63.129.16",
    "192.0.0.192",
    "198.19.0.1",
    "2001:2::1",
    "240.0.0.1",
    "::ffff:0:a9fe:a9fe",
  ];
  await spying(stop, async () => {
    for (const address of addresses) {
      const literal = address.includes(":") ? `[${address}]` : address;
      await refusal(fetchSafe(`http://${literal}/`, options), "egress_blocked_address");
      const answer = { ...options, resolve: async () => [address] };
      await refusal(fetchSafe("http://site.test/", answer), "egress_blocked_address");
    }
  });
});

test("a redirect to a private address is refused at the hop; a chain past maxRedirects is refused", async () => {
  seen.length = 0;
  asked.length = 0;
  const to = (target: string) => `${base}/to?url=${encodeURIComponent(target)}`;
  await refusal(fetchSafe(to("http://10.0.0.1/"), options), "egress_blocked_address");
  await refusal(fetchSafe(to("http://internal.test/"), options), "egress_blocked_address");
  // The allow entry names one port of the local server; another port is a blocked address again.
  await refusal(
    fetchSafe(to(`http://127.0.0.1:${closedPort}/`), options),
    "egress_blocked_address",
  );
  await refusal(fetchSafe(to("gopher://example.com/"), options), "egress_bad_scheme");
  assert.equal(seen.length, 4);
  assert.deepEqual(asked, ["internal.test"]);
  seen.length = 0;
  const twoOnly = { ...options, maxRedirects: 2 };
  await refusal(fetchSafe(`${base}/hop/3`, twoOnly), "egress_too_many_redirects");
  assert.deepEqual(
    seen.map(({ path }) => path),
    ["/hop/3", "/hop/2", "/hop/1"],
  );
  assert.equal((await fetchSafe(`${base}/hop/2`, twoOnly)).hops, 2);
  const noRedirect = { ...options, maxRedirects: 0 };
  await refusal(fetchSafe(`${base}/hop/1`, noRedirect), "egress_too_many_redirects");
});

test("returnRedirect: the redirect past maxRedirects comes back, its target never requested", async () => {
  seen.length = 0;
  const target = `${base}/hop/0`;
  const moved = `${base}/moved?url=${encodeURIComponent(target)}`;
  const answer = { ...options, maxRedirects: 0, returnRedirect: true };
  const response = await fetchSafe(moved, answer);
  assert.deepEqual(
    [response.status, response.headers.location, response.finalUrl, response.hops],
    [301, target, moved, 0],
  );
  assert.deepEqual(
    seen.map(({ path }) => path),
    ["/moved"],
  );
  // Read like a final response: a head that crosses the wire bound is refused, not answered.
  const crossing = fetchSafe(`http://127.0.0.1:${rawPort}/crossing`, answer);
  await refusal(crossing, "egress_too_large");
});

test("returnRedirect, maxRedirects 1: the first redirect followed and checked, the second answered", async () => {
  seen.length = 0;
  spans.reset();
  const oneHop = { ...options, maxRedirects: 1, returnRedirect: true };
  const response = await fetchSafe(`${base}/hop/2`, oneHop);
  assert.deepEqual(
    [response.status, response.headers.location, response.finalUrl, response.hops],
    [302, "/hop/0", `${base}/hop/1`, 1],
  );
  assert.deepEqual(
    seen.map(({ path }) => path),
    ["/hop/2", "/hop/1"],
  );
  // The span of a final response: the host, the status, the bytes and the redirects followed.
  const { duration_ms, ...attributes } = spans.getFinishedSpans()[0]?.attributes ?? {};
  const expected = { host: "127.0.0.1", status: 302, response_bytes: 0, redirect_count: 1 };
  assert.deepEqual(attributes, expected);
  assert.equal(typeof duration_ms, "number");
  // The redirect it follows is checked as before: one to a private address is refused at the hop.
  const toPrivate = `${base}/to?url=${encodeURIComponent("http://10.0.0.1/")}`;
  await refusal(fetchSafe(toPrivate, oneHop), "egress_blocked_address");
});

test("a body past maxBytes is egress_too_large; a stall, egress_timeout", deadline, async () => {
  const bytes = (maxBytes: number) => ({ ...options, maxBytes });
  await refusal(fetchSafe(`${base}/large`, bytes(2047)), "egress_too_large");
  await refusal(fetchSafe(`${base}/chunked`, bytes(2047)), "egress_too_large");
  assert.equal((await fetchSafe(`${base}/chunked`, bytes(2048))).body.length, 2048);
  // 1xx heads count on the wire too: 128 KiB of them pass 2 × 1024 + 64 KiB, not 2 × 1 MiB.
  await refusal(fetchSafe(`${base}/hints`, options), "egress_too_large");
  const roomy = { ...bytes(2 ** 20), timeoutMs: 100 };
  await refusal(fetchSafe(`${base}/hints`, roomy), "egress_timeout");
  // So do blank lines before the status line: 128 KiB of them, and no status line.
  await refusal(fetchSafe(`http://127.0.0.1:${rawPort}/blank`, options), "egress_too_large");
  // A 302 whose head crosses the bound in the read that brings it is refused, not followed.
  await refusal(fetchSafe(`http://127.0.0.1:${rawPort}/crossing`, options), "egress_too_large");
  const started = performance.now();
  const soon = { ...options, timeoutMs: 200 };
  await refusal(fetchSafe(`${base}/stall`, soon), "egress_timeout");
  // A body with no length, which the close ends: the deadline's close cuts it and does not end it.
  await refusal(fetchSafe(`http://127.0.0.1:${rawPort}/open`, soon), "egress_timeout");
  const silent: Resolver = () => new Promise(() => {});
  await refusal(fetchSafe("http://slow.test/", { ...soon, resolve: silent }), "egress_timeout");
  assert.ok(performance.now() - started < 2000);
});

test("one buffer for the body, sized by what arrives, bounded on the wire", deadline, async () => {
  const patient = { ...options, maxBytes: 32_768, timeoutMs: 5_000 }; // a slow machine drips slowly
  const dripping = (bytes: number) => fetchSafe(`http://127.0.0.1:${rawPort}/${bytes}`, patient);
  assert.ok((await dripping(4096)).body.equals(Buffer.alloc(4096, "A")));
  // 32 KiB of body is 192 KiB on the wire, past 2 × maxBytes + 64 KiB: refused before it ends.
  await refusal(dripping(32_768), "egress_too_large");
  // A Content-Length is a claim: 256 MiB declared and six bytes sent hold 64 KiB, not 256 MiB.
  const before = process.memoryUsage().arrayBuffers;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  }, 5);
  const claim = { ...options, maxBytes: 2 ** 28, timeoutMs: 300 };
  await refusal(fetchSafe(`${base}/stall?declare=${2 ** 28}`, claim), "egress_timeout");
  clearInterval(sampler);
  assert.ok(peak - before < 2 ** 24, `${peak - before} bytes held`);
});

test("a call always settles: a 101 answer, a request that never answers", deadline, async () => {
  // With no upgrade listener, Node closes a 101 answer's socket and emits neither a response nor an
  // error: the close settles the call.
  await refusal(fetchSafe(`http://127.0.0.1:${rawPort}/upgrade`, options), "egress_request_failed");
  // A request that never emits anything ends at the deadline all the same.
  const silent = () => Object.assign(new EventEmitter(), { end: () => {} });
  const publicSite = { ...options, timeoutMs: 100, resolve: async () => ["203.0.113.10"] };
  const call = () => refusal(fetchSafe("http://public.test/", publicSite));
  assert.equal((await spying(silent, call)).code, "egress_timeout");
});

test("a body only the close ends: a reset fails it, a clean close ends it", deadline, async () => {
  const at = (path: string) => fetchSafe(`http://127.0.0.1:${rawPort}/${path}`, options);
  const reset = await refusal(at("reset"), "egress_request_failed");
  assert.deepEqual(reset.details, { reason: "ECONNRESET" });
  const closed = await at("closed");
  assert.deepEqual([closed.status, closed.body.toString()], [200, "whole"]);
  // A 302 whose chunked body is malformed in the read that brings its head: refused, not followed.
  const garbled = await refusal(at("garbled"), "egress_request_failed");
  assert.deepEqual(garbled.details, { reason: "HPE_INVALID_CHUNK_SIZE" });
});

test("bytes past a whole body, by length or last chunk, do not fail it", deadline, async () => {
  // In the read that brings the body: the parser errs on them once the body is complete.
  for (const path of ["extra", "chunked-extra"]) {
    const response = await fetchSafe(`http://127.0.0.1:${rawPort}/${path}`, options);
    assert.deepEqual([response.status, response.body.toString()], [200, "hello"]);
  }
});

test("truncate: true keeps maxBytes bytes, says so, closes the connection", deadline, async () => {
  const cut = { ...options, maxBytes: 1000, truncate: true };
  for (const route of ["large", "chunked"]) {
    const response = await fetchSafe(`${base}/${route}`, cut);
    assert.deepEqual([response.body.length, response.truncated], [1000, true]);
  }
  assert.equal((await fetchSafe(`${base}/chunked`, { ...cut, maxBytes: 2048 })).truncated, false);
  // A body that never ends: its first bytes at once, well before the deadline, and the close.
  const head = await fetchSafe(`${base}/stall`, { ...cut, maxBytes: 3 });
  assert.deepEqual([head.body.toString(), head.truncated], ["sta", true]);
  await stalled;
});

test("the connection goes to the address checked: a rebinding DNS cannot make it connect privately", async () => {
  seen.length = 0;
  attempts.length = 0;
  // The checked answer passes the rules and is unreachable (a multicast address, whose connect the
  // system refuses at once): nothing leaves the machine. A second resolution, through node:dns,
  // would get the local server: the rebind.
  let asks = 0;
  const rebinding: Resolver = async () => (asks++ === 0 ? [unconnectable] : ["127.0.0.1"]);
  let systemAsked = 0;
  const systemLookup = nodeDns.lookup;
  const rebound = (
    _host: string,
    given: { all?: boolean },
    callback: (...a: unknown[]) => void,
  ) => {
    systemAsked += 1;
    if (given.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  Object.assign(nodeDns, { lookup: rebound });
  try {
    const call = fetchSafe(`http://rebind.test:${port}/hop/0`, { ...options, resolve: rebinding });
    await refusal(call, "egress_request_failed"); // Node's code for it differs by system
  } finally {
    Object.assign(nodeDns, { lookup: systemLookup });
  }
  assert.deepEqual([asks, systemAsked], [1, 0]);
  assert.deepEqual(attempts, [`${unconnectable}:${port}`]);
  assert.deepEqual(seen, []);
});

test("each request: host name for TLS, certificate checked, pinned, unpooled, strict parser", async () => {
  const sent: https.RequestOptions[] = [];
  const stop = (given: https.RequestOptions) => {
    sent.push(given);
    throw Object.assign(new Error("stopped before connecting"), { code: "ESTOPPED" });
  };
  const publicSite = { ...options, resolve: async () => ["203.0.113.10"] };
  for (const url of ["https://public.test/path?q", "http://public.test/path?q"]) {
    const error = await spying(stop, () => refusal(fetchSafe(url, publicSite)));
    assert.deepEqual(
      [error.code, error.details],
      ["egress_request_failed", { reason: "ESTOPPED" }],
    );
  }
  assert.equal(sent.length, 2);
  for (const given of sent) {
    // No servername and no Host header: Node takes both from the host name, never the address.
    assert.deepEqual([given.hostname, given.servername], ["public.test", undefined]);
    assert.equal((given.headers as Record<string, string>).host, undefined);
    assert.equal(given.rejectUnauthorized, true);
    assert.equal(given.agent, false);
    assert.deepEqual([given.insecureHTTPParser, given.maxHeaderSize], [false, 16_384]);
    assert.equal(typeof given.lookup, "function");
    const answer = (all: boolean) =>
      new Promise((resolve) => {
        given.lookup?.("elsewhere.test", { all }, (_error, ...found) => resolve(found));
      });
    assert.deepEqual(await answer(true), [[{ address: "203.0.113.10", family: 4 }]]);
    assert.deepEqual(await answer(false), ["203.0.113.10", 4]);
  }
});

test("a redirect from https down to http is refused before anything is sent in clear", async () => {
  let requests = 0;
  const redirecting = (_given: https.RequestOptions, respond: (response: unknown) => void) => {
    requests += 1;
    const location = "http://public.test/next";
    const response = { statusCode: 302, headers: { location }, destroy: () => {} };
    return Object.assign(new EventEmitter(), { end: () => respond(response) });
  };
  const publicSite = { ...options, resolve: async () => ["203.0.113.10"] };
  const call = () => refusal(fetchSafe("https://public.test/", publicSite));
  assert.equal((await spying(redirecting, call)).code, "egress_insecure_redirect");
  assert.equal(requests, 1);
});

test("a step down from https that is returned comes back as it is; followed, it is refused", async () => {
  let requests = 0;
  const location = "http://public.test/next";
  const redirecting = (_given: https.RequestOptions, respond: (response: unknown) => void) => {
    requests += 1;
    // A body to read: a redirect that is returned is read as a final response is.
    const body = Readable.from([Buffer.from("moved")]);
    const response = Object.assign(body, { statusCode: 302, headers: { location } });
    return Object.assign(new EventEmitter(), { end: () => respond(response) });
  };
  const publicSite = { ...options, returnRedirect: true, resolve: async () => ["203.0.113.10"] };
  const returned = () => fetchSafe("https://public.test/", { ...publicSite, maxRedirects: 0 });
  const response = await spying(redirecting, returned);
  assert.deepEqual(
    [response.status, response.headers.location, response.body.toString(), response.finalUrl],
    [302, location, "moved", "https://public.test/"],
  );
  const followed = () => fetchSafe("https://public.test/", { ...publicSite, maxRedirects: 1 });
  await refusal(spying(redirecting, followed), "egress_insecure_redirect");
  assert.equal(requests, 2);
});

test("the defaults come from config; out-of-range bounds fail closed", deadline, async () => {
  // EGRESS_DEFAULT_MAX_BYTES is 1024 and EGRESS_DEFAULT_TIMEOUT_MS 500, set before the import.
  await refusal(fetchSafe(`${base}/large`, { maxRedirects: 0, lists }), "egress_too_large");
  await refusal(fetchSafe(`${base}/stall`, { maxRedirects: 0, lists }), "egress_timeout");
  assert.deepEqual(
    { ...readFetchSafeConfig({}) },
    { EGRESS_DEFAULT_TIMEOUT_MS: 10_000, EGRESS_DEFAULT_MAX_BYTES: 1_048_576 },
  );
  for (const env of [
    { EGRESS_DEFAULT_MAX_BYTES: "lots" },
    { EGRESS_DEFAULT_MAX_BYTES: String(2 ** 28 + 1) },
    { EGRESS_DEFAULT_TIMEOUT_MS: String(2 ** 31) },
  ]) {
    assert.throws(
      () => readFetchSafeConfig(env),
      (error: unknown) => isAppError(error) && error.code === "config_invalid",
    );
  }
  const bad = [
    { maxBytes: Number.NaN },
    { maxBytes: 2 ** 28 + 1 },
    { timeoutMs: -1 },
    { timeoutMs: 2 ** 31 }, // setTimeout would fire at once
    { maxRedirects: 1.5 },
  ];
  for (const bound of bad) {
    await refusal(fetchSafe(`${base}/hop/0`, { ...options, ...bound }), "egress_invalid_options");
  }
});

test("a span per call with the host, status, bytes and duration, never the path or the query", async () => {
  spans.reset();
  await fetchSafe(`${base}/hop/1?token=t0ken`, options);
  const blocked = fetchSafe("http://private.test/hop/0?token=t0ken", options);
  await refusal(blocked, "egress_blocked_address");
  const [ok, refused, ...more] = spans.getFinishedSpans();
  assert.deepEqual(more, []);
  assert.equal(ok?.name, "egress.fetch");
  const { duration_ms, ...attributes } = ok?.attributes ?? {};
  assert.deepEqual(attributes, {
    host: "127.0.0.1",
    status: 200,
    response_bytes: 6,
    redirect_count: 1,
  });
  assert.equal(typeof duration_ms, "number");
  assert.equal(refused?.attributes.host, "private.test");
  assert.equal(refused?.attributes.code, "egress_blocked_address");
  const recorded = JSON.stringify([ok, refused].map((s) => [s?.name, s?.attributes, s?.status]));
  assert.doesNotMatch(recorded, /t0ken|hop/);
});

test("in production: no trace context, no URL exported, lists only narrow", spawned, async () => {
  const collector = await startCollector();
  seen.length = 0;
  try {
    const report = await runHost(`${base}/hop/1?token=t0ken`, {
      APP_ENV: "production",
      EGRESS_ALLOW_HOSTS: `127.0.0.1:${port}`,
      EGRESS_DEFAULT_TIMEOUT_MS: "10000",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collector.port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    });
    const narrowing = {
      widened: "egress_invalid_options",
      narrowed: "egress_denied_host",
      getter: "egress_blocked_address", // read once: the operator's list, which names no localhost
    };
    assert.deepEqual(report, { status: 200, hops: 1, ...narrowing });
    assert.deepEqual(
      seen.map(({ path }) => path),
      ["/hop/1", "/hop/0"],
    );
    const sent = seen.flatMap(({ headers }) => Object.keys(headers));
    assert.deepEqual(
      sent.filter((name) => ["traceparent", "tracestate", "baggage"].includes(name)),
      [],
    );
    const exported = collector.bodies.join("\n");
    assert.match(exported, /"egress\.fetch"/);
    assert.doesNotMatch(exported, /t0ken|\/hop\/|url\.full|url\.path|url\.query/);
  } finally {
    await collector.close();
  }
});

test("a refused connection is egress_request_failed with Node's code; failures answer as a gateway", async () => {
  const closed = { allowHosts: parseHostList(`127.0.0.1:${closedPort}`) };
  const call = fetchSafe(`http://127.0.0.1:${closedPort}/`, { maxRedirects: 0, lists: closed });
  const error = await refusal(call, "egress_request_failed");
  assert.deepEqual(error.details, { reason: "ECONNREFUSED" });
  const statuses = ["dns_failed", "too_many_redirects", "insecure_redirect", "too_large"];
  assert.deepEqual(
    [...statuses, "timeout", "request_failed"].map((code) => httpStatus(`egress_${code}`)),
    [502, 502, 502, 502, 504, 502],
  );
  assert.equal(httpStatus("egress_invalid_options"), 500);
});

/** The AppError a call rejects with, with the code when one is given. */
async function refusal(call: Promise<unknown>, code?: string): Promise<AppError> {
  const error = await call.then(
    () => assert.fail(`expected ${code ?? "a refusal"}, got a response`),
    (reason: unknown) => reason,
  );
  assert.ok(isAppError(error), String(error));
  if (code !== undefined) assert.equal(error.code, code);
  return error;
}

/** Runs `call` with http.request and https.request replaced by `spy`, then puts them back. */
async function spying<T>(
  spy: (given: https.RequestOptions, respond: (response: unknown) => void) => unknown,
  call: () => Promise<T>,
) {
  const original = { http: http.request, https: https.request };
  Object.assign(http, { request: spy });
  Object.assign(https, { request: spy });
  try {
    return await call();
  } finally {
    Object.assign(http, { request: original.http });
    Object.assign(https, { request: original.https });
  }
}

/** Runs the fixture host on `url` with `env` over this process's own; its report, once it exits. */
async function runHost(url: string, env: Record<string, string>): Promise<unknown> {
  const host = fileURLToPath(new URL("./fixtures/egress/host.ts", import.meta.url));
  const child = spawn(process.execPath, [host, url], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(exit, 0, `the fixture host failed:\n${err}`);
  return JSON.parse(out.trim().split("\n").at(-1) ?? "null");
}

/** An OTLP receiver on 127.0.0.1 that keeps every body it is sent, as text. */
async function startCollector() {
  const bodies: string[] = [];
  const collector = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  const collectorPort = await listen(collector);
  const close = () => new Promise<void>((resolve) => collector.close(() => resolve()));
  return { port: collectorPort, bodies, close };
}

/** Listens on a free port of 127.0.0.1 and returns it. */
async function listen(target: net.Server): Promise<number> {
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  return (target.address() as AddressInfo).port;
}
