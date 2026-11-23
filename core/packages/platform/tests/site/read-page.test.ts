// readPage end to end (gamma-wr-020; README "The site reader"): one page the caller names, an HTML
// page or a PDF file, read through fetchSafe from a server this test runs on 127.0.0.1, a blocked
// address the egress client reaches through EGRESS_ALLOW_HOSTS (set before the platform loads, for
// this process and this port only). The PDF files are built by pdf-files.ts, their text made up.
// readSite's own tests, pages.test.ts and the worker's, pass unchanged. A host the caller refuses (gamma-wr-045)
// is never requested, neither the page's nor a redirect hop's.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, test } from "node:test";
import { pdf, scanPdf, textPdf } from "./pdf-files.ts";

const HTML = { "content-type": "text/html; charset=utf-8" };
const PDF = { "content-type": "application/pdf" };
const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const requests: string[] = [];
let robots: { status: number; body: string } = { status: 404, body: "" };
const routes: Record<string, (response: ServerResponse) => void> = {
  "/fair/exhibitors": (res) =>
    res
      .writeHead(200, HTML)
      .end(
        html(
          "Exhibitors 2031",
          '<main><h1>Exhibitors</h1><p>Hall A: Marlow Tools, Hall B: Quillon Mills.</p><p><a href="/fair/stands">Stands</a> <a href="mailto:Stands@Fair.test">Write</a></p></main>',
        ),
      ),
  "/fair/private": (res) => res.writeHead(200, HTML).end(html("Private", "<p>Not for robots</p>")),
  "/fair/second": (res) => res.writeHead(200, HTML).end(html("Second", "<p>Second page</p>")),
  "/files/list.pdf": (res) =>
    res
      .writeHead(200, PDF)
      .end(textPdf(["Marlow Tools, hall A", "Quillon Mills, hall B"], "Exhibitor list")),
  "/files/untitled.pdf": (res) => res.writeHead(200, PDF).end(textPdf(["Only a line"])),
  "/files/scan.pdf": (res) => res.writeHead(200, PDF).end(scanPdf()),
  "/files/broken.pdf": (res) => res.writeHead(200, PDF).end("%PDF-1.4\nnot a PDF\n"),
  "/files/many.pdf": (res) =>
    res
      .writeHead(200, PDF)
      .end(
        pdf(
          Array.from(
            { length: 51 },
            (_, at) => `BT /F1 12 Tf 72 720 Td (Page number ${at + 1}) Tj ET`,
          ),
        ),
      ),
  "/files/fifty.pdf": (res) =>
    res
      .writeHead(200, PDF)
      .end(
        pdf(
          Array.from(
            { length: 50 },
            (_, at) => `BT /F1 12 Tf 72 720 Td (Page number ${at + 1}) Tj ET`,
          ),
        ),
      ),
  "/files/gzip.pdf": (res) =>
    res.writeHead(200, { ...PDF, "content-encoding": "gzip" }).end(textPdf(["Compressed"])),
  "/files/plain.pdf": (res) =>
    res.writeHead(200, { "content-type": "text/plain" }).end(textPdf(["Not labelled a PDF"])),
  "/redirect/private": (res) => res.writeHead(302, { location: "http://10.0.0.7/secret" }).end(),
  "/redirect/metadata": (res) =>
    res.writeHead(302, { location: "http://169.254.169.254/latest" }).end(),
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = (req.url ?? "").split("?")[0] ?? "";
  requests.push(req.url ?? "");
  if (path === "/robots.txt") {
    res.writeHead(robots.status, { "content-type": "text/plain" }).end(robots.body);
  } else if (path === "/files/big.pdf") {
    // One byte past the bound, sent whole: a file past it, never read to its end.
    res.writeHead(200, PDF).end(Buffer.alloc(FETCH_LIMITS.pdfBytes + 1, 0x20));
  } else if (path === "/files/at-bound.pdf") {
    res.writeHead(200, PDF).end(Buffer.alloc(FETCH_LIMITS.pdfBytes, 0x20));
  } else if (path === "/fair/large") {
    // 1.5 MB of HTML: the page's own bound of one megabyte holds when a PDF's is five.
    res.writeHead(200, HTML).end(html("Large", `<p>First</p><!--${"x".repeat(1_500_000)}-->`));
  } else if (path === "/files/long.pdf") {
    // 20 pages of 100 lines of 60 characters in a small font, 120,000 characters in all.
    const lines = Array.from({ length: 100 }, () => `(${"word ".repeat(12)}) Tj T*`).join(" ");
    const page = `BT /F1 4 Tf 5 TL 10 780 Td ${lines} ET`;
    res.writeHead(200, PDF).end(pdf(Array.from({ length: 20 }, () => page)));
  } else {
    const route = routes[path];
    if (route === undefined) res.writeHead(404).end();
    else route(res);
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// A second host, 127.0.0.2, the target of a redirect the caller refuses: it counts what it is asked.
const targetRequests: string[] = [];
const target = createServer((req, res) => {
  targetRequests.push(req.url ?? "");
  res.writeHead(200, HTML).end(html("Target", "<p>Reached</p>"));
});
await new Promise<void>((resolve) => target.listen(0, "127.0.0.2", resolve));
const targetOrigin = `http://127.0.0.2:${(target.address() as AddressInfo).port}`;
routes["/redirect/refused"] = (res) =>
  res.writeHead(302, { location: `${targetOrigin}/target` }).end();
process.env.EGRESS_ALLOW_HOSTS = `${new URL(origin).host},${new URL(targetOrigin).host}`;
after(() => {
  server.closeAllConnections();
  server.close();
  target.closeAllConnections();
  target.close();
});

const { FETCH_LIMITS, readPage, readSite } = await import("../../http/index.ts");
const { readPdf } = await import("../../http/site/pdf.ts");
type RobotsByHost = NonNullable<NonNullable<Parameters<typeof readPage>[1]>["robots"]>;

const read = (path: string, options?: Parameters<typeof readPage>[1]) =>
  readPage(new URL(path, origin), options);
const fresh = () => {
  requests.length = 0;
  robots = { status: 404, body: "" };
};

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
/**
 * `fn`'s result, with what it tried to send (a fetch, a socket, unless `sockets` is false: a read
 * reaches this file's server) or print, each refused or kept.
 */
async function watched<T>(
  fn: () => Promise<T>,
  { sockets = true } = {},
): Promise<{ result: T; tried: unknown[] }> {
  const tried: unknown[] = [];
  const saved = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect };
  const methods = Object.fromEntries(METHODS.map((name) => [name, console[name]]));
  const refuse = (what: string) => (): never => {
    tried.push(what);
    throw new Error(`refused: ${what}`);
  };
  globalThis.fetch = refuse("fetch");
  if (sockets) net.Socket.prototype.connect = refuse("connect");
  for (const name of METHODS) console[name] = (...args: unknown[]) => tried.push([name, args]);
  try {
    return { result: await fn(), tried };
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch });
    net.Socket.prototype.connect = saved.connect;
    Object.assign(console, methods);
  }
}

test("an HTML page on 127.0.0.1 is read: its address, title, text, links and mailto addresses, robots.txt first", async () => {
  fresh();
  const result = await read("/fair/exhibitors");
  assert.deepEqual(result, {
    ok: true,
    page: {
      url: `${origin}/fair/exhibitors`,
      title: "Exhibitors 2031",
      text: "# Exhibitors\nHall A: Marlow Tools, Hall B: Quillon Mills.\nStands Write",
      links: [{ href: `${origin}/fair/stands`, nav: false }],
      mailto: ["stands@fair.test"],
      status: "fetched",
    },
  });
  assert.deepEqual(requests, ["/robots.txt", "/fair/exhibitors"]);
});

test("a path robots.txt disallows is site_disallowed and the page is never asked for; a robots.txt that answers 500 lets nothing be read", async () => {
  fresh();
  robots = { status: 200, body: "User-agent: *\nDisallow: /fair/private\n" };
  assert.deepEqual(await read("/fair/private"), { ok: false, code: "site_disallowed" });
  assert.deepEqual(requests, ["/robots.txt"]);
  assert.equal((await read("/fair/exhibitors")).ok, true);

  fresh();
  robots = { status: 500, body: "" };
  assert.deepEqual(await read("/fair/exhibitors"), { ok: false, code: "site_disallowed" });
  assert.deepEqual(requests, ["/robots.txt"]);

  // A 4xx is no rules.
  fresh();
  robots = { status: 403, body: "" };
  assert.equal((await read("/fair/exhibitors")).ok, true);
});

test("a PDF file with text answers its text, pages merged, its title when it has one, and no links", async () => {
  fresh();
  const result = await read("/files/list.pdf");
  assert.deepEqual(result, {
    ok: true,
    page: {
      url: `${origin}/files/list.pdf`,
      title: "Exhibitor list",
      text: "Marlow Tools, hall A\nQuillon Mills, hall B",
      links: [],
      mailto: [],
      status: "fetched",
    },
  });
  const untitled = await read("/files/untitled.pdf");
  assert.ok(untitled.ok);
  assert.deepEqual([untitled.page.title, untitled.page.text], ["", "Only a line"]);
  // 50 pages are within the bound.
  const fifty = await read("/files/fifty.pdf");
  assert.ok(fifty.ok);
  assert.match(fifty.page.text, /Page number 50$/);
});

test("a PDF file past the byte bound, past the page bound, with no text, broken, compressed or not labelled a PDF (or a page) is fetch_failed; one at the byte bound reaches the parser", async () => {
  fresh();
  const failed = { ok: false, code: "fetch_failed" };
  for (const path of [
    "/files/big.pdf",
    "/files/many.pdf",
    "/files/scan.pdf",
    "/files/broken.pdf",
    "/files/gzip.pdf",
    "/files/plain.pdf",
    "/files/at-bound.pdf", // 5 MB of spaces: within the bound, no PDF
  ]) {
    assert.deepEqual(await read(path), failed, path);
  }
});

test("an HTML page past a megabyte is cut at a megabyte and truncated, a PDF's larger bound notwithstanding", async () => {
  fresh();
  const result = await read("/fair/large");
  assert.ok(result.ok);
  assert.equal(result.page.status, "truncated");
  assert.equal(result.page.text, "First");
});

test("a text past 50,000 characters is cut there and truncated, in a PDF file as in a page", async () => {
  fresh();
  const result = await read("/files/long.pdf");
  assert.ok(result.ok);
  assert.equal(result.page.text.length, FETCH_LIMITS.text);
  assert.equal(result.page.status, "truncated");
});

test("a redirect to a private or metadata address is refused with the egress code, and nothing is asked of it", async () => {
  fresh();
  for (const path of ["/redirect/private", "/redirect/metadata"]) {
    const result = await read(path);
    assert.equal(result.ok, false, path);
    assert.ok(!result.ok && result.code.startsWith("egress_"), path);
  }
  // The address itself, as the page named: refused before any connection.
  const direct = await readPage(new URL("http://10.0.0.7/page"));
  assert.ok(!direct.ok && direct.code.startsWith("egress_"));
});

test("a host the caller refuses is never requested: the page's own, and a redirect hop's before the hop is asked for; the answer is egress_denied_host, and without the option the redirect is followed", async () => {
  fresh();
  targetRequests.length = 0;
  const refuseHost = (host: string) => host === "127.0.0.2";
  assert.deepEqual(await read("/redirect/refused", { refuseHost }), {
    ok: false,
    code: "egress_denied_host",
  });
  assert.deepEqual(requests, ["/robots.txt", "/redirect/refused"]);
  assert.deepEqual(targetRequests, [], "the refused host was asked for something");
  // The page itself on a refused host: not even its robots.txt is requested.
  const own = await readPage(new URL("/target", targetOrigin), { refuseHost });
  assert.deepEqual(own, { ok: false, code: "egress_denied_host" });
  assert.deepEqual(targetRequests, []);
  // The same redirect with no option is followed to the target, which is asked.
  const followed = await read("/redirect/refused");
  assert.equal(followed.ok, true);
  assert.deepEqual(targetRequests, ["/target"]);
});

test("a site read refuses a host the caller names as a page's does (gamma-wr-050): a home page that moves to it is never followed", async () => {
  fresh();
  targetRequests.length = 0;
  const home = new URL("/redirect/refused", origin);
  const refuseHost = (host: string) => host === "127.0.0.2";
  assert.deepEqual(await readSite(home, { maxPages: 1, preferred: [], refuseHost }), {
    ok: false,
    code: "egress_denied_host",
  });
  assert.deepEqual(targetRequests, []);
  assert.equal((await readSite(home, { maxPages: 1, preferred: [] })).ok, true);
  assert.deepEqual(targetRequests, ["/target"]);
});

test("two pages of one host, read with the first read's rules, ask for robots.txt once; another host's own", async () => {
  fresh();
  const rules: RobotsByHost = new Map();
  assert.equal((await read("/fair/exhibitors", { robots: rules })).ok, true);
  assert.equal((await read("/fair/second", { robots: rules })).ok, true);
  assert.deepEqual(requests, ["/robots.txt", "/fair/exhibitors", "/fair/second"]);
  assert.deepEqual([...rules.keys()], [origin]);
  // The rules kept hold: a page they disallow is refused without a request.
  rules.set(origin, [{ allow: false, path: "/fair/second" }]);
  requests.length = 0;
  assert.deepEqual(await read("/fair/second", { robots: rules }), {
    ok: false,
    code: "site_disallowed",
  });
  assert.deepEqual(requests, []);
  // Without a map, each read asks.
  await read("/fair/second");
  await read("/fair/second");
  assert.deepEqual(requests, ["/robots.txt", "/fair/second", "/robots.txt", "/fair/second"]);
});

test("beat runs before robots.txt and before the page, and once for a host whose rules are known", async () => {
  fresh();
  const rules: RobotsByHost = new Map();
  let beats = 0;
  await read("/fair/exhibitors", { robots: rules, beat: () => beats++ });
  assert.equal(beats, 2);
  await read("/fair/second", { robots: rules, beat: () => beats++ });
  assert.equal(beats, 3);
});

test("parsing a PDF file fetches nothing, opens no socket and prints nothing; a refused file as well", async () => {
  const files = [textPdf(["Marlow Tools"], "Made up"), scanPdf(), Buffer.from("%PDF-1.4\nnope\n")];
  const { result, tried } = await watched(() =>
    Promise.all(files.map((file) => readPdf(new Uint8Array(file), 10_000))),
  );
  assert.deepEqual(tried, []);
  assert.deepEqual(result, [{ title: "Made up", text: "Marlow Tools", cut: false }, null, null]);
});

test("the PDF parser is loaded by the first PDF read, not before: a site read adds no PDF.js global", async () => {
  // This file's earlier tests have read PDF files: a fresh process shows the globals' absence.
  const { execFileSync } = await import("node:child_process");
  const script = `
    const before = new Set(Reflect.ownKeys(globalThis).map(String));
    await import(${JSON.stringify(new URL("../../http/index.ts", import.meta.url).href)});
    const added = () => Reflect.ownKeys(globalThis).map(String).filter((key) => !before.has(key));
    const loaded = added();
    const { readPdf } = await import(${JSON.stringify(new URL("../../http/site/pdf.ts", import.meta.url).href)});
    console.log(JSON.stringify({ loaded: added() }));
    const { textPdf } = await import(${JSON.stringify(new URL("./pdf-files.ts", import.meta.url).href)});
    await readPdf(new Uint8Array(textPdf(["x"])), 10000);
    console.log(JSON.stringify({ added: added() }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, APP_ENV: "test" },
  })
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { loaded?: string[]; added?: string[] });
  // Importing the reader adds none of PDF.js's; the first PDF adds its four.
  const pdfjs = ["DOMMatrix", "_pdfjsTestingUtils", "pdfjsLib", "pdfjsWorker"];
  assert.deepEqual(
    out[0]?.loaded?.filter((key) => pdfjs.includes(key)),
    [],
  );
  assert.deepEqual(out[1]?.added?.filter((key) => pdfjs.includes(key)).sort(), pdfjs);
});

test("no code, no thrown error and no output holds the page's address or text", async () => {
  fresh();
  const marker = "zq7-marker";
  routes[`/${marker}/secret.pdf`] = (res) =>
    res.writeHead(200, PDF).end(textPdf([`${marker} body text`]).subarray(0, 300));
  routes[`/${marker}/page`] = (res) =>
    res.writeHead(200, HTML).end(html(`${marker} title`, `<p>${marker} text</p>`));
  const results: unknown[] = [];
  const errors: unknown[] = [];
  const { tried } = await watched(
    async () => {
      for (const path of [
        `/${marker}/secret.pdf`,
        `/${marker}/page`,
        `/${marker}/gone`,
        `/redirect/private?${marker}`,
      ]) {
        try {
          const result = await read(path);
          results.push(result.ok ? { ok: true } : result);
        } catch (error) {
          errors.push(String(error));
        }
      }
      try {
        await readPage(new URL(`http://10.0.0.7/${marker}`));
      } catch (error) {
        errors.push(String(error));
      }
    },
    { sockets: false },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(tried, []);
  assert.doesNotMatch(JSON.stringify(results), new RegExp(marker));
  // The refusals answer a code; the cut file reads as no PDF.
  assert.deepEqual(results[0], { ok: false, code: "fetch_failed" });
  assert.deepEqual(results[2], { ok: false, code: "fetch_failed" });
  assert.match((results[3] as { code: string }).code, /^egress_/);
});
