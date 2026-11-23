// The pages of a research run (README.md "Web research"; gamma-wr-045): the address rules and the
// queue in code, then the queue and the page steps on a server this test runs on 127.0.0.2 to
// 127.0.0.6, hosts the egress client reaches through EGRESS_ALLOW_HOSTS (set before the platform
// loads), the web search's https addresses served there by a reader in place of platform's that only
// changes the scheme and the host (useReadPage). The start pages and the picks are lined up, start
// pages first, a few pages of one host at most; each page is read once, a host's robots.txt asked
// once, a page robots.txt closes never requested, a LinkedIn address, `localhost` and a private
// address never reached; a PDF file is read as text, a page with little text is asked again of the
// browser; each page goes to the files port; at the limit nothing is fetched and `budget_reached` is
// set once; a step run again fetches nothing.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import { textPdf } from "../testing/pdf.ts";

const HTML = { "content-type": "text/html; charset=utf-8" };
const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const LONG = "A made-up company that sells and services refrigerated vehicles for food traders. ";
const prose = (name: string) => `<p>${name}. ${LONG.repeat(3)}</p>`;
/** The hosts the web search answers and the address of each on this machine. */
const ADDRESS = {
  "nord.example": "127.0.0.2",
  "fair.example": "127.0.0.3",
  "closed.example": "127.0.0.4",
  "thin.example": "127.0.0.5",
  "hop.example": "127.0.0.6",
} as const;
const SITE_OF = new Map<string, string>(Object.entries(ADDRESS).map(([name, ip]) => [ip, name]));

const requests: string[] = [];
const answered: string[] = [];
const pages: Record<string, Record<string, (res: ServerResponse) => void>> = {
  "nord.example": Object.fromEntries(
    ["/", "/about", "/team", "/contact", "/news"].map((path) => [
      path,
      (res: ServerResponse) => res.writeHead(200, HTML).end(html(`Nord ${path}`, prose("Nord"))),
    ]),
  ),
  "fair.example": {
    "/exhibitors": (res) =>
      res.writeHead(200, HTML).end(html("Exhibitors", `<h1>Exhibitors</h1>${prose("Fair")}`)),
    "/files/award.pdf": (res) =>
      res
        .writeHead(200, { "content-type": "application/pdf" })
        .end(textPdf(["Award notice: the contract goes to Quillon Mills of Brno"])),
  },
  "closed.example": {
    "/private/list": (res) => res.writeHead(200, HTML).end(html("Private", prose("Closed"))),
  },
  "thin.example": {
    "/app": (res) => res.writeHead(200, HTML).end(html("App", "<p>Loading</p>")),
  },
  // Pages that move to a host never fetched: the redirect hop must not be requested.
  "hop.example": {
    "/to-linkedin": (res) =>
      res.writeHead(302, { location: "https://www.linkedin.com/company/quillon-mills" }).end(),
    "/to-short-link": (res) => res.writeHead(302, { location: "https://lnkd.in/quillon" }).end(),
  },
};
const robots: Record<string, { status: number; body: string }> = {
  "closed.example": { status: 200, body: "User-agent: *\nDisallow: /private\n" },
};
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const ip = (req.headers.host ?? "").split(":")[0] ?? "";
  const name = SITE_OF.get(ip) ?? "";
  const path = (req.url ?? "").split("?")[0] ?? "";
  requests.push(`${name}${path}`);
  if (path === "/robots.txt") {
    const rule = robots[name] ?? { status: 404, body: "" };
    res.writeHead(rule.status, { "content-type": "text/plain" }).end(rule.body);
    return;
  }
  const route = pages[name]?.[path];
  if (route === undefined) res.writeHead(404).end("not found");
  else route(res);
});
await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
const { port } = server.address() as AddressInfo;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = Object.values(ADDRESS)
  .map((ip) => `${ip}:${port}`)
  .join(",");
after(() => {
  server.closeAllConnections();
  server.close();
});

process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_BROWSER = "fake";
process.env.SIGNALS_RESEARCH_PAGES_PER_RUN = "6";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { readPage, servicePrincipal } = await import("@whytide/platform");
const { browserPort, filesConfig, filesPort, getAdapter } = await import("@whytide/providers");
const { PAGES_PER_HOST, PAGES_QUEUE_FACTOR } = await import("../domain/research/constants.ts");
const { pageKey, pickKey, queueKey, readJsonFile } = await import("../domain/research/files.ts");
const { hostKeyOf, neverFetched, pageUrlOf, queueOf } = await import("../domain/research/pages.ts");
const { readQueuedPage } = await import("../domain/research/page.ts");
const { queueResearchPages } = await import("../domain/research/queue.ts");
const { writeRunFile } = await import("../domain/runs.ts");
const { createResearchPlan, createSignalRun, createSignalSource, forgetReads, useReadPage } =
  await import("../testing/index.ts");
const { useSignalsClient } = await import("../testing/index.ts");

type Files = { reset(): void };
type Browser = import("@whytide/providers").BrowserFake;
withTestDb();
const app = asRole("app");
useSignalsClient(app);
const files = (await getAdapter(filesPort, filesConfig.PROVIDER_FILES)) as unknown as Files;
const browser = (await getAdapter(browserPort, "fake")) as unknown as Browser;
const principal = servicePrincipal("signals_test");
const tenantOf =
  (workspaceId: string) =>
  <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
// The https address the search answered, served by a host of this machine; any other host keeps its
// own name, and so reaches the egress client's rules: localhost and a private address are refused.
useReadPage((url, options) => {
  const ip = ADDRESS[url.hostname as keyof typeof ADDRESS];
  const plain = new URL(url);
  plain.protocol = "http:";
  if (ip !== undefined) {
    plain.hostname = ip;
    plain.port = String(port);
  }
  const answer = readPage(plain, options);
  void answer.then((read) => answered.push(read.ok ? "ok" : read.code));
  return answer;
});
beforeEach(() => {
  requests.length = 0;
  answered.length = 0;
  files.reset();
  browser.reset();
  forgetReads();
});

const URL_OF = (host: string, path = "/") => `https://${host}${path}`;

test("an address is a page when it is http or https with no user, password or fragment and not on LinkedIn or a social network or a subdomain of one; a host and its www are one host", () => {
  assert.equal(pageUrlOf("https://Nord.Example/team#top"), "https://nord.example/team");
  assert.equal(pageUrlOf("http://nord.example:8080/a?b=1"), "http://nord.example:8080/a?b=1");
  for (const refused of [
    "https://www.linkedin.com/company/a",
    "https://pl.linkedin.com/company/a",
    "https://lnkd.in/x",
    "https://m.facebook.com/a",
    "https://x.com/a",
    "ftp://nord.example/a",
    "mailto:ops@nord.example",
    "https://user:pass@nord.example/",
    "not a link",
  ]) {
    assert.equal(pageUrlOf(refused), null, refused);
  }
  assert.ok(neverFetched("LinkedIn.com.") && neverFetched("a.b.twitter.com"));
  assert.ok(!neverFetched("notlinkedin.com") && !neverFetched("nord.example"));
  assert.equal(hostKeyOf("https://www.nord.example/a"), hostKeyOf("https://nord.example/b"));
});

test("the queue holds the start pages first, then the picks round by round, each address once, at most a few pages of one host, and PAGES_QUEUE_FACTOR times the limit at most", () => {
  const starts = ["https://a.example/", "https://a.example/#again", "https://www.linkedin.com/x"];
  const picks = [
    {
      placeId: "web_search",
      urls: ["https://b.example/1", "https://b.example/2", "https://c.example/"],
    },
    { placeId: "fair_exhibitors", urls: ["https://c.example/", "https://d.example/"] },
  ];
  assert.deepEqual(queueOf(starts, picks, 10), [
    { url: "https://a.example/", placeId: null },
    { url: "https://b.example/1", placeId: "web_search" },
    { url: "https://c.example/", placeId: "fair_exhibitors" },
    { url: "https://b.example/2", placeId: "web_search" },
    { url: "https://d.example/", placeId: "fair_exhibitors" },
  ]);
  const one = [
    "https://a.example/1",
    "https://www.a.example/2",
    "https://a.example/3",
    "https://a.example/4",
  ];
  assert.equal(queueOf(one, [], 10).length, PAGES_PER_HOST);
  const many = Array.from({ length: 30 }, (_, at) => `https://host-${at}.example/`);
  assert.equal(queueOf(many, [], 2).length, 2 * PAGES_QUEUE_FACTOR);
});

/** A research source with its run open, the start pages and the picks (by position) given. */
async function queued(
  tag: string,
  startPages: string[],
  picks: { placeId: string; urls: string[] }[],
) {
  const workspaceId = `wsp_pages${tag}`;
  const config = { focus: "refrigerated vehicles", startPages };
  const source = await createSignalSource({
    ...{ workspaceId, label: tag, kind: "web_research", config },
    senderAccountId: null,
  });
  const run = await createSignalRun({ workspaceId, sourceId: source.id, status: "running" });
  await createResearchPlan({ workspaceId, sourceId: source.id, runId: run.id });
  const ref = { workspaceId, sourceId: source.id, runId: run.id };
  for (const [at, pick] of picks.entries()) {
    await writeRunFile(workspaceId, pickKey(run.id, at + 1), pick);
  }
  const queue = await queueResearchPages(ref, picks.length, tenantOf(workspaceId));
  const read = (index: number, before: number) =>
    readQueuedPage(ref, index, before, tenantOf(workspaceId));
  const counts = async () =>
    ((await app.signalRun.findFirstOrThrow({ where: { id: run.id } })).counts ?? {}) as Record<
      string,
      number
    >;
  const filed = (index: number) => readJsonFile(workspaceId, pageKey(run.id, index));
  return { ref, queue, read, counts, filed, workspaceId };
}

test("a run's pages: the start pages and the picks are lined up, a few pages of one host at most, and read one a step, each once, to the files port; a host's robots.txt is asked once, a page it closes is never requested, a PDF file is read as text, a page with little text is asked again of the browser, and a LinkedIn address, localhost and a private address are never requested", async () => {
  const thin = `http://${ADDRESS["thin.example"]}:${port}/app`;
  browser.seedPage(thin, {
    text: `${LONG.repeat(2)} Rendered by the browser, Quillon Mills of Brno.`,
    links: [{ href: "https://quillon.example/", text: "Quillon" }],
  });
  const run = await queued(
    "main",
    [URL_OF("nord.example"), "https://localhost/start", "https://10.0.0.5/start"],
    [
      {
        placeId: "web_search",
        urls: ["/about", "/team", "/contact", "/news"]
          .map((path) => URL_OF("nord.example", path))
          .concat(URL_OF("fair.example", "/exhibitors")),
      },
      {
        placeId: "public_tenders",
        urls: [
          URL_OF("fair.example", "/files/award.pdf"),
          URL_OF("closed.example", "/private/list"),
          URL_OF("thin.example", "/app"),
          "https://www.linkedin.com/company/quillon-mills",
        ],
      },
    ],
  );
  assert.deepEqual(run.queue, { status: "queued", pages: 9 });
  const queue = (await readJsonFile(run.workspaceId, queueKey(run.ref.runId))) as {
    pages: { url: string; placeId: string | null }[];
  };
  assert.deepEqual(
    queue.pages.map(({ url, placeId }) => [url.replace("https://", ""), placeId]),
    [
      ["nord.example/", null],
      ["localhost/start", null],
      ["10.0.0.5/start", null],
      ["nord.example/about", "web_search"],
      ["fair.example/files/award.pdf", "public_tenders"],
      ["nord.example/team", "web_search"],
      ["closed.example/private/list", "public_tenders"],
      ["thin.example/app", "public_tenders"],
      ["fair.example/exhibitors", "web_search"],
    ],
  );
  const statuses: string[] = [];
  let read = 0;
  for (let index = 1; index <= run.queue.pages; index += 1) {
    const { status } = await run.read(index, read);
    statuses.push(status);
    if (status === "read") read += 1;
  }
  assert.deepEqual(statuses, [
    ...["read", "failed", "failed", "read", "read", "read", "closed", "read", "read"],
  ]);
  assert.deepEqual(await run.counts(), { pages: 6, pages_failed: 2, pages_closed: 1 });
  // Never requested: the closed page, a fourth page of one host, LinkedIn, localhost, the private address.
  assert.ok(!requests.includes("closed.example/private/list"));
  assert.ok(!requests.some((made) => made.startsWith("nord.example/contact")));
  assert.ok(!requests.some((made) => made.includes("news")));
  assert.equal(requests.filter((made) => made === "nord.example/robots.txt").length, 1);
  assert.equal(requests.filter((made) => made === "closed.example/robots.txt").length, 1);
  assert.deepEqual(
    [...requests].sort(),
    [
      ...["closed.example/robots.txt", "fair.example/exhibitors", "fair.example/files/award.pdf"],
      ...[
        "fair.example/robots.txt",
        "nord.example/",
        "nord.example/about",
        "nord.example/robots.txt",
      ],
      ...["nord.example/team", "thin.example/app", "thin.example/robots.txt"],
    ].sort(),
  );
  const pdf = (await run.filed(5)) as { text: string; placeId: string; url: string };
  assert.ok(pdf.text.includes("Quillon Mills of Brno") && pdf.placeId === "public_tenders");
  assert.equal(pdf.url, "https://fair.example/files/award.pdf");
  const shown = (await run.filed(8)) as {
    text: string;
    rendered: boolean;
    links: { href: string }[];
  };
  assert.ok(shown.rendered && shown.text.includes("Rendered by the browser"));
  assert.ok(shown.links.some(({ href }) => href === "https://quillon.example/"));
  const plain = (await run.filed(1)) as { rendered: boolean; title: string; links: unknown[] };
  assert.deepEqual([plain.rendered, plain.title], [false, "Nord /"]);
  assert.equal(await run.filed(2), null);
  assert.equal(await run.filed(7), null);
});

test("a picked result that redirects to LinkedIn or a short link is dropped before the hop is requested: the reader is refused the host, answers egress_denied_host, and the page counts as failed", async () => {
  const run = await queued(
    "hops",
    [],
    [
      {
        placeId: "web_search",
        urls: [URL_OF("hop.example", "/to-linkedin"), URL_OF("hop.example", "/to-short-link")],
      },
    ],
  );
  assert.deepEqual(run.queue, { status: "queued", pages: 2 });
  assert.deepEqual(await run.read(1, 0), { status: "failed" });
  assert.deepEqual(await run.read(2, 0), { status: "failed" });
  assert.deepEqual(answered, ["egress_denied_host", "egress_denied_host"]);
  assert.deepEqual(await run.counts(), { pages_failed: 2 });
  assert.equal(await run.filed(1), null);
  // The pages themselves were asked for, once each, and robots.txt once; nothing else (the hops are
  // hosts of the internet, so one that was requested would have answered another code).
  assert.deepEqual(
    [...requests].sort(),
    ["hop.example/robots.txt", "hop.example/to-linkedin", "hop.example/to-short-link"].sort(),
  );
});

test("a page step run again, or after its file was written, fetches nothing and says read; the pages' limit fetches nothing, sets budget_reached once and the run goes on counting the same", async () => {
  const run = await queued("again", [URL_OF("nord.example", "/about")], []);
  assert.deepEqual(await run.read(1, 0), { status: "read" });
  const fetched = requests.length;
  assert.deepEqual(await run.read(1, 1), { status: "read" });
  assert.equal(requests.length, fetched, "a page read was fetched again");
  assert.deepEqual(await run.counts(), { pages: 1 });
  assert.deepEqual(await run.read(2, 1), { status: "skipped" }, "no such page");
  // `read` is the pages read so far: at the limit (6) nothing is fetched.
  const second = await queued("limit", [URL_OF("nord.example", "/team")], []);
  assert.deepEqual(await second.read(1, 6), { status: "budget" });
  assert.deepEqual(await second.read(1, 7), { status: "budget" });
  assert.deepEqual(await second.counts(), { budget_reached: 1 });
  assert.ok(!requests.includes("nord.example/team"));
});
