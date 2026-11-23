// The source `website` (gamma-en-065; README "The website source"): synthetic sites this test serves on
// 127.0.0.1 (the test allow-list), the LLM fake and the browser fake, against a schema of the
// worktree's database for callAgent's records. The facts read with a quote found in their page, the
// LinkedIn page from a footer and never a person's; the AI given only the company's name, the fields
// wanted and the pages; a page that shows its text only once its script runs read through the
// browser, browser_unavailable keeping the plain page; robots.txt's Disallow: / blocking every page
// and the AI; a quote not in its page failing twice; only the wanted fields answered, a country
// contacts does not know dropped. The writes, the provenance and the run are the worker's
// tests/enrichment-run.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, beforeEach, test } from "node:test";
import type { BrowserFake, LlmFake } from "@whytide/providers";

const HTML = { "content-type": "text/html; charset=utf-8" };
const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const ABOUT_TEXT =
  "Alder Freight moves pallets for bakeries and breweries across the north of England. ".repeat(3);
const pages: Record<string, string> = {
  "/alder/": html(
    "Alder Freight",
    `<h1>Pallet freight for food makers</h1><p>${ABOUT_TEXT}</p>
    <p><a href="/alder/about">About us</a> <a href="/alder/team">Team</a></p>
    <footer><a href="https://www.linkedin.com/in/alder-founder">Our founder</a>
    <a href="https://uk.linkedin.com/company/Alder-Freight/">LinkedIn</a></footer>`,
  ),
  "/alder/about": html(
    "About Alder Freight",
    "<p>Our headquarters are in Leeds, United Kingdom.</p><p>We are a team of 85 drivers and planners.</p>",
  ),
  "/alder/team": html("Team", "<p>Meet the planners.</p>"),
  // Its text comes only from its script: the browser renders it.
  "/birch/": html(
    "Birch Robotics",
    `<div id="app"></div><script>document.getElementById("app").textContent = "x";</script>
    <a href="https://www.linkedin.com/in/birch-person">Founder</a>`,
  ),
};
let robots = "User-agent: *\nAllow: /\n";
const served: string[] = [];
const site = createServer((req, res) => {
  served.push(req.url ?? "");
  if (req.url === "/robots.txt")
    return res.writeHead(200, { "content-type": "text/plain" }).end(robots);
  const page = pages[req.url ?? ""];
  if (page === undefined) res.writeHead(404).end();
  else res.writeHead(200, HTML).end(page);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = new URL(origin).host;
after(() => {
  site.closeAllConnections();
  site.close();
});

const { DATA_SENTENCE, loadAgentTasks } = await import("@whytide/ai");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { isAppError } = await import("@whytide/platform");
const { browserPort, getAdapter, llmPort } = await import("@whytide/providers");
const { websiteSource } = await import("../domain/sources/website/index.ts");
const { readCompanySite } = await import("../domain/sources/website/site.ts");
const { useAgentCall, useSiteHome } = await import("../testing/index.ts");

withTestDb();
await loadAgentTasks([new URL("../agents/read-company-site/task.ts", import.meta.url).href]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const browser = (await getAdapter(browserPort, "fake")) as unknown as BrowserFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
useAgentCall({ client: asRole("app"), prices });
// A domain's home page is this test's site, under its first label.
useSiteHome((domain) => new URL(`${origin}/${domain.split(".")[0]}/`));
beforeEach(() => {
  llm.reset();
  browser.reset();
  served.length = 0;
  robots = "User-agent: *\nAllow: /\n";
});

const ALL = ["linkedinUrl", "industry", "sizeRange", "country", "description"] as const;
type Wanted = (typeof ALL)[number];
const ask = (domain: string, wanted: readonly Wanted[] = ALL, name = "Alder Freight") =>
  websiteSource.run(
    {
      workspaceId: `wsp_${randomUUID().replaceAll("-", "")}`,
      companyId: `co_${randomUUID().replaceAll("-", "")}`,
      company: { domain, name },
      wanted,
    },
    { tenant: (fn) => fn() },
  );
const at = (path: string) => `${origin}${path}`;
const cite = <T>(value: T, path: string, quote: string) => ({ value, url: at(path), quote });
const NONE = {
  industry: null,
  employeeCount: null,
  employeeRange: null,
  country: null,
  description: null,
};
const READ = {
  industry: cite("Pallet freight", "/alder/", "Pallet freight for food makers"),
  employeeCount: cite(85, "/alder/about", "a team of 85 drivers"),
  employeeRange: null,
  country: cite("GB", "/alder/about", "headquarters are in Leeds, United Kingdom"),
  description: cite(
    "Alder Freight moves pallets for bakeries and breweries.",
    "/alder/",
    "moves pallets for bakeries and breweries",
  ),
};

type Recorded = { system: string; messages: { content: { text: string }[] }[] };
const userText = (index: number) =>
  (llm.recordedCalls[index]?.input as Recorded).messages
    .flatMap((message) => message.content.map((part) => part.text))
    .join("");
/** The blocks of the recorded call's user message, by name, each parsed as JSON or as it is. */
function blocksOf(index: number): Record<string, unknown> {
  const blocks: Record<string, unknown> = {};
  for (const [, name = "", body = ""] of userText(index).matchAll(/<(\w+)>\n([\s\S]*?)\n<\/\1>/g)) {
    try {
      blocks[name] = JSON.parse(body);
    } catch {
      blocks[name] = body;
    }
  }
  return blocks;
}
const failsWith = (code: string) => (error: unknown) => isAppError(error) && error.code === code;

test("a company's own pages: robots.txt, the home page, then about and team; the facts each with a quote found in its page, the size as a headcount, the LinkedIn page from the footer and never a person's; the AI given only the company's name, the fields wanted and the pages", async () => {
  llm.script(READ);
  const answer = await ask("alder.example");
  assert.deepEqual(answer, {
    found: true,
    facts: {
      linkedinUrl: "https://www.linkedin.com/company/alder-freight",
      industry: "Pallet freight",
      description: "Alder Freight moves pallets for bakeries and breweries.",
      country: "GB",
      employeeCount: 85,
    },
  });
  assert.deepEqual(served, ["/robots.txt", "/alder/", "/alder/about", "/alder/team"]);
  assert.equal(llm.recordedCalls.length, 1);
  const recorded = llm.recordedCalls[0]?.input as Recorded;
  assert.ok(recorded.system.startsWith("Data blocks: <company>, <wanted>, <pages>\n"));
  assert.ok(recorded.system.includes(DATA_SENTENCE));
  const blocks = blocksOf(0);
  assert.deepEqual(Object.keys(blocks), ["company", "wanted", "pages"]);
  assert.equal(blocks.company, "Alder Freight");
  assert.deepEqual(blocks.wanted, ["industry", "size", "country", "description"]);
  const sent = blocks.pages as { url: string; title: string; text: string }[];
  assert.deepEqual(
    sent.map(({ url, title }) => [url, title]),
    [
      [at("/alder/"), "Alder Freight"],
      [at("/alder/about"), "About Alder Freight"],
      [at("/alder/team"), "Team"],
    ],
  );
  assert.ok(sent.every((page) => Object.keys(page).join() === "url,title,text"));
  assert.ok(!userText(0).includes("linkedin.com/in/"), "a link reached the model");
});

test("a page that shows its text only once its script runs is read through the browser when the plain page is short; browser_unavailable keeps the plain page", async () => {
  const rendered = "Birch Robotics builds picking robots for small warehouses. ".repeat(5);
  browser.seedPage(at("/birch/"), {
    text: rendered,
    links: [{ href: "https://www.linkedin.com/company/birch-robotics", text: "LinkedIn" }],
  });
  const answer = { ...NONE, industry: cite("Warehouse robots", "/birch/", "picking robots") };
  llm.script(answer);
  const read = await ask("birch.example", ["industry", "linkedinUrl"], "Birch Robotics");
  assert.deepEqual(read, {
    found: true,
    facts: {
      linkedinUrl: "https://www.linkedin.com/company/birch-robotics",
      industry: "Warehouse robots",
    },
  });
  assert.deepEqual(
    browser.recordedCalls.map(({ input }) => input),
    [{ url: at("/birch/") }],
  );
  const [page] = blocksOf(0).pages as { text: string }[];
  assert.equal(page?.text, rendered);

  // The service down: the plain page, too short to quote, and no page from the browser's links.
  browser.failNext("browser_unavailable");
  llm.script(NONE);
  const plain = await ask("birch.example", ["industry", "linkedinUrl"], "Birch Robotics");
  assert.deepEqual(plain, { found: false });
  const [kept] = blocksOf(1).pages as { text: string }[];
  assert.ok((kept?.text.length ?? 0) < 200);
  assert.ok(!kept?.text.includes("picking robots"));
});

test("robots.txt Disallow: / reads no page beyond robots.txt, records blocked and makes no AI call; nor does the browser render one", async () => {
  robots = "User-agent: *\nDisallow: /\n";
  assert.deepEqual(await ask("alder.example"), { found: false, outcome: "blocked" });
  assert.deepEqual(await ask("birch.example"), { found: false, outcome: "blocked" });
  assert.deepEqual(served, ["/robots.txt", "/robots.txt"]);
  assert.equal(llm.recordedCalls.length, 0);
  assert.equal(browser.recordedCalls.length, 0);
});

test("a value whose quote is not in its page fails the grounded gate; the retry fails again: enrichment_site_ai_failed, nothing answered", async () => {
  const misquoted = { ...READ, industry: cite("Pallet freight", "/alder/team", "pallets daily") };
  const elsewhere = { ...READ, country: { ...READ.country, url: "https://other.example/" } };
  llm.script(misquoted, elsewhere);
  await assert.rejects(ask("alder.example"), failsWith("enrichment_site_ai_failed"));
  assert.equal(llm.recordedCalls.length, 2);
  assert.match(userText(1), /<validation_error>[\s\S]*"gate": "grounded"/);
});

test("only the fields wanted are asked and answered; a size range as contacts takes it; a country contacts does not know is dropped; no wanted field the AI reads, no AI call", async () => {
  const answer = {
    ...READ,
    employeeCount: null,
    employeeRange: cite({ from: 51, to: 200 }, "/alder/about", "a team of 85"),
    country: cite("QQ", "/alder/about", "Leeds, United Kingdom"),
  };
  llm.script(answer);
  const read = await ask("alder.example", ["sizeRange", "country"]);
  assert.deepEqual(read, { found: true, facts: { sizeRange: "51-200" } });
  assert.deepEqual(blocksOf(0).wanted, ["size", "country"]);

  const page = await ask("alder.example", ["linkedinUrl"]);
  assert.deepEqual(page, {
    found: true,
    facts: { linkedinUrl: "https://www.linkedin.com/company/alder-freight" },
  });
  assert.equal(llm.recordedCalls.length, 1);
});

test("the reader's caller gives its own page limit (gamma-wr-050); a host it refuses is not asked of the browser, whose page ended there keeps its plain page", async () => {
  const some = await readCompanySite("alder.example", () => {});
  assert.equal(some.ok && some.pages.length, 3);
  const two = await readCompanySite("alder.example", () => {}, undefined, { maxPages: 2 });
  assert.equal(two.ok && two.pages.length, 2);
  const [home, about] = two.ok ? two.pages : [];
  assert.match(home?.url ?? "", /\/alder\/$/);
  assert.match(about?.url ?? "", /\/alder\/about$/);
  const one = await readCompanySite("alder.example", () => {}, undefined, { maxPages: 1 });
  assert.equal(one.ok && one.pages.length, 1);

  // A script-only page the browser renders on a host the caller refuses is not used.
  const rendered = "Birch Robotics builds picking robots for small warehouses. ".repeat(5);
  browser.seedPage(at("/birch/"), {
    text: rendered,
    links: [],
    finalUrl: "https://www.refused.example/birch",
  });
  const refuseHost = (host: string) => host === "www.refused.example";
  const kept = await readCompanySite("birch.example", () => {}, undefined, { refuseHost });
  assert.ok(kept.ok && !(kept.pages[0]?.text ?? "").includes("picking robots"));
  const used = await readCompanySite("birch.example", () => {});
  assert.ok(used.ok && (used.pages[0]?.text ?? "").includes("picking robots"));
});
