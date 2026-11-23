// The free email sources (gamma-en-085; README "The sources reply, website and pattern"): the names'
// cleaning table, role addresses, the patterns, what a site's pages tell (the lead's own address, the
// domain's pattern from the others, the names around them), the reply's candidates, the pattern
// source's guesses against a schema of the worktree's database, and the website source on synthetic
// pages this test serves on 127.0.0.1 (the test allow-list). gamma-rf-030: a domain's several
// patterns, their order, the bound on the guesses, the writes and the migration's copy. The lookups
// end to end are the worker's tests/enrichment-lookup.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

const HTML = { "content-type": "text/html; charset=utf-8" };
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const pages: Record<string, string> = {
  "/acme/": page(
    `<h1>Acme</h1><p><a href="/acme/team">Team</a> <a href="/acme/contact">Contact</a></p>`,
  ),
  "/acme/team":
    page(`<p>John Smith, john.smith@acme.example</p><p>Mia Wong – mia.wong@acme.example</p>
    <p>Sales: sales@acme.example</p>`),
  "/acme/contact": page(`<p>Write to info@acme.example</p>
    <footer><a href="mailto:Jane.Doe@acme.example?subject=Hello">Jane</a></footer>`),
};
const site = createServer((req, res) => {
  if (req.url === "/robots.txt") return res.writeHead(200).end("User-agent: *\nAllow: /\n");
  const body = pages[req.url ?? ""];
  if (body === undefined) res.writeHead(404).end();
  else res.writeHead(200, HTML).end(body);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
// The platform's egress config reads it as it loads, below.
process.env.EGRESS_ALLOW_HOSTS = new URL(origin).host;
after(() => {
  site.closeAllConnections();
  site.close();
});

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { servicePrincipal } = await import("@whytide/platform");
const { cleanName, namesOf } = await import("../domain/email/names.ts");
const { isRoleAddress } = await import("../domain/email/roles.ts");
const { applyPattern, patternOf, rankPatterns } = await import("../domain/email/patterns.ts");
const { readSiteAddresses } = await import("../domain/email/site.ts");
const { domainStatusOf, writePattern } = await import("../domain/email/domain-pattern.ts");
const { replyCandidates } = await import("../domain/sources/reply.ts");
const { patternSource } = await import("../domain/sources/pattern.ts");
const { websiteEmailSource } = await import("../domain/sources/website/email.ts");
const { useSiteHome } = await import("../testing/index.ts");

withTestDb();
const app = asRole("app");
const WS = "wsp_enrichment_email_sources";
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal: servicePrincipal("enrichment_test") }, fn, {
    client: app,
  });
useSiteHome((domain) => new URL(`${origin}/${domain.split(".")[0]}/`));
const AT = new Date("2026-11-14T09:00:00Z");
const DAY_MS = 86_400_000;

const JANE = { first: "jane", last: "doe" };
const input = (companyDomain: string, room = 3, firstName = "Jane", lastName = "Doe") => ({
  workspaceId: WS,
  personId: "per_email_sources",
  firstName,
  lastName,
  companyDomain,
  room,
});
const context = { tenant: run };
/** The pattern source's guesses at the domain, or its answer when it made none. */
const guesses = async (domain: string, room: number): Promise<unknown> => {
  const answer = await patternSource.run(input(domain, room), context);
  return answer.found ? answer.candidates.map(({ address }) => address) : answer;
};
/** The domain's pattern rows: the pattern, its count, when last verified and when seen. */
const stored = async (domain: string) =>
  (await app.emailDomainPattern.findMany({ where: { domain }, orderBy: { pattern: "asc" } })).map(
    ({ pattern, verifiedCount, lastVerifiedAt, siteSeenAt }) => [
      pattern,
      verifiedCount,
      lastVerifiedAt?.toISOString() ?? null,
      siteSeenAt?.toISOString() ?? null,
    ],
  );
/** The migration's copy of email_domain_statuses' patterns (gamma-rf-030), its last statement. */
function migrationCopy(): string {
  const migrations = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  const folder = readdirSync(migrations).find((name) =>
    name.endsWith("_enrichment_domain_patterns"),
  );
  const sql = readFileSync(new URL(`${folder}/migration.sql`, migrations), "utf8");
  return sql.slice(sql.indexOf('INSERT INTO "email_domain_patterns"'));
}

test("names are cleaned as names.ts's table says: lower case, accents folded, letters only; the first given name and the whole family name", () => {
  const cases: [string, string, string, string][] = [
    ["Jürgen", "Strauß", "jurgen", "strauss"],
    ["José María", "García-López", "jose", "garcialopez"],
    ["Zoë", "van der Berg", "zoe", "vanderberg"],
    ["Łukasz", "Søndergård", "lukasz", "sondergard"],
    ["Mary-Kate", "O'Brien", "marykate", "obrien"],
    ["李", "Wang", "", "wang"],
  ];
  for (const [given, family, first, last] of cases) {
    assert.deepEqual(namesOf(given, family), { first, last }, `${given} ${family}`);
  }
  assert.equal(cleanName("Ægir Þór"), "aegirthor");
});

test("role addresses are ignored, whatever their separators or digits; a person's address is not one", () => {
  for (const role of [
    "info@acme.example",
    "Sales@acme.example",
    "no-reply@acme.example",
    "careers2@acme.example",
    "press@acme.example",
    "hr@acme.example",
  ]) {
    assert.ok(isRoleAddress(role), role);
  }
  for (const person of ["jane.doe@acme.example", "jdoe@acme.example", "hello.jane@acme.example"]) {
    assert.ok(!isRoleAddress(person), person);
  }
});

test("the patterns applied to the names, and the pattern a local part fits; none without both names", () => {
  assert.equal(applyPattern("{first}.{last}", JANE), "jane.doe");
  assert.equal(applyPattern("{f}{last}", JANE), "jdoe");
  assert.equal(applyPattern("{first}{l}", JANE), "janed");
  assert.equal(applyPattern("{first}", { first: "jane", last: "" }), null);
  assert.equal(patternOf("J.Doe", JANE), "{f}.{last}");
  assert.equal(patternOf("doe.jane", JANE), "{last}.{first}");
  assert.equal(patternOf("jane.d", JANE), null);
});

test("a site's addresses: the lead's own a candidate, mailto's included; the others give the pattern most agree on, two names joined directly, any other only with a full name within 200 characters; role addresses and other domains never", () => {
  const read = (texts: string[], mailto: string[] = []) =>
    readSiteAddresses(
      texts.map((text, n) => ({ text, mailto: n === 0 ? mailto : [] })),
      "acme.example",
      JANE,
    );
  assert.deepEqual(read(["John Smith, john.smith@acme.example"]), {
    own: [],
    pattern: "{first}.{last}",
  });
  assert.deepEqual(
    read(
      ["Team: Tom Ray (tray@acme.example), Ana Bell (abell@acme.example), a.k@acme.example"],
      ["Jane.Doe@acme.example".toLowerCase()],
    ),
    { own: ["jane.doe@acme.example"], pattern: "{f}{last}" },
  );
  // Far from any name, `tray` gives nothing; two names joined still do; majority wins.
  const far = `tray@acme.example ${"x ".repeat(150)} Tom Ray`;
  assert.deepEqual(read([far]), { own: [], pattern: null });
  assert.deepEqual(
    read(["ann_lee@acme.example bo_kim@acme.example cy.ng@acme.example jdoe@other.example"]),
    { own: [], pattern: "{first}_{last}" },
  );
  assert.deepEqual(read(["info@acme.example support@acme.example jdoe@acme.example"]), {
    own: ["jdoe@acme.example"],
    pattern: null,
  });
});

test("the reply's candidates: a message's one address, of several only those holding the lead's name, role addresses ignored, each once, the company's domain first", () => {
  const given = [
    ["janed1987@gmail.com"],
    ["jane.doe@acme.example", "tom.ray@acme.example"],
    ["sales@acme.example", "jd@partner.example"],
    ["jane.doe@acme.example"],
  ];
  assert.deepEqual(replyCandidates(given, JANE, "acme.example"), [
    "jane.doe@acme.example",
    "janed1987@gmail.com",
    "jd@partner.example",
  ]);
  assert.deepEqual(
    replyCandidates([["tom.ray@acme.example", "mia@acme.example"]], JANE, "acme.example"),
    [],
  );
});

test("the pattern source: a domain recorded catch-all gets no guess; without a pattern the common patterns in order, as many as the room allows; no name, no guess", async () => {
  await app.emailDomainStatus.create({
    data: {
      ...{ id: "eds_catch_all", domain: "loose.example", catchAll: true, provider: "fake" },
      ...{ checkedAt: AT, expiresAt: new Date(Date.now() + DAY_MS) },
    },
  });
  assert.deepEqual(await patternSource.run(input("loose.example"), context), {
    found: false,
    outcome: "catch_all_domain",
  });
  assert.deepEqual(await guesses("acme.example", 3), [
    "jane.doe@acme.example",
    "jane@acme.example",
    "jdoe@acme.example",
  ]);
  assert.equal(((await guesses("acme.example", 9)) as string[]).length, 7);
  assert.deepEqual(await guesses("acme.example", 0), { found: false, outcome: "no_guess" });
  const noLatin = await patternSource.run(input("acme.example", 3, "李", "王"), context);
  assert.deepEqual(noLatin, { found: false, outcome: "no_guess" });
});

test("acme.com has {first}.{last} verified 5 times and {f}{last} once: Jane Doe gets jane.doe@acme.com first, then jdoe@acme.com, and no third guess; never more than the room; one known pattern makes one guess (gamma-rf-030)", async () => {
  const recent = new Date(Date.now() - 2 * DAY_MS);
  await app.emailDomainPattern.createMany({
    data: [
      { domain: "acme.com", pattern: "{f}{last}", verifiedCount: 1, lastVerifiedAt: recent },
      { domain: "acme.com", pattern: "{first}.{last}", verifiedCount: 5, lastVerifiedAt: recent },
      { domain: "acme.com", pattern: "{first}", siteSeenAt: new Date() },
    ],
  });
  assert.deepEqual(await guesses("acme.com", 3), ["jane.doe@acme.com", "jdoe@acme.com"]);
  assert.deepEqual(await guesses("acme.com", 1), ["jane.doe@acme.com"]);
  assert.deepEqual(await guesses("acme.com", 0), { found: false, outcome: "no_guess" });
  await run(() => writePattern("seen.example", "{f}.{last}", "website", new Date()));
  assert.deepEqual(await guesses("seen.example", 3), ["j.doe@seen.example"]);
});

test("a domain's patterns in order: the higher count, then the later verification, then the later sighting on the site, then PATTERNS' order; a name off the list dropped", () => {
  const day = (n: number) => new Date(AT.getTime() - n * DAY_MS);
  const row = (
    pattern: string,
    verifiedCount: number,
    verified: number | null,
    seen: number | null,
  ) => ({
    pattern,
    verifiedCount,
    lastVerifiedAt: verified === null ? null : day(verified),
    siteSeenAt: seen === null ? null : day(seen),
  });
  assert.deepEqual(
    rankPatterns([
      row("{last}", 0, null, 1),
      row("{first}", 0, null, 1),
      row("{f}.{last}", 0, null, 3),
      row("{first}{last}", 2, 9, null),
      row("{f}{last}", 2, 4, 50),
      row("{first}_{last}", 2, 4, 2),
      row("{first}.{last}", 7, 100, null),
      row("jane.doe@acme.example", 9, 1, 1),
    ]),
    [
      "{first}.{last}",
      "{first}_{last}",
      "{f}{last}",
      "{first}{last}",
      "{first}",
      "{last}",
      "{f}.{last}",
    ],
  );
});

test("a domain's writes, each one statement: a verified address adds 1 and sets its time; a site's pattern sets when it was seen and never a count; a site's and a verified one for the domain are two rows, neither changing the other; two writes at once lose no count; the CHECKs refuse an address, a count without its time and a row never verified nor seen", async () => {
  const later = new Date(AT.getTime() + DAY_MS);
  await run(() => writePattern("acme.example", "{first}", "verified", AT));
  await run(() => writePattern("acme.example", "{last}", "website", AT));
  await run(() => writePattern("acme.example", "{first}", "verified", later));
  await run(() => writePattern("acme.example", "{first}", "website", later));
  await run(() => writePattern("acme.example", "{last}", "website", later));
  assert.deepEqual(await stored("acme.example"), [
    ["{first}", 2, later.toISOString(), later.toISOString()],
    ["{last}", 0, null, later.toISOString()],
  ]);
  assert.deepEqual(await app.emailDomainStatus.findMany({}), []);
  await Promise.all(
    Array.from({ length: 8 }, () =>
      run(() => writePattern("race.example", "{f}{last}", "verified", AT)),
    ),
  );
  assert.deepEqual(await stored("race.example"), [["{f}{last}", 8, AT.toISOString(), null]]);
  assert.deepEqual(await run(() => domainStatusOf("acme.example", later)), {
    catchAll: false,
    patterns: ["{first}", "{last}"],
  });
  const refused = (data: Record<string, unknown>) =>
    assert.rejects(
      app.emailDomainPattern.create({ data: { domain: "bad.example", ...data } } as never),
    );
  await refused({ pattern: "jane.doe@acme.example", siteSeenAt: AT });
  await refused({ pattern: "{first}", verifiedCount: 1, siteSeenAt: AT });
  await refused({ pattern: "{first}", verifiedCount: 0, lastVerifiedAt: AT });
  await refused({ pattern: "{first}" });
});

test("a pattern last verified and last seen more than 180 days ago is not read, and its row stays; one seen within its days is read whatever its age", async () => {
  const old = new Date(AT.getTime() - 181 * DAY_MS);
  await run(() => writePattern("acme.example", "{f}.{last}", "verified", old));
  await run(() => writePattern("acme.example", "{last}", "website", old));
  assert.deepEqual(await run(() => domainStatusOf("acme.example", AT)), {
    catchAll: false,
    patterns: [],
  });
  assert.equal(await app.emailDomainPattern.count({ where: { domain: "acme.example" } }), 2);
  await run(() => writePattern("acme.example", "{f}.{last}", "website", AT));
  assert.deepEqual((await run(() => domainStatusOf("acme.example", AT))).patterns, ["{f}.{last}"]);
});

test("after the migration, a domain that had a pattern still gets one guess with it: its copy of email_domain_statuses' patterns, a verified one counted once and a site's seen", async () => {
  const at = new Date();
  for (const [domain, pattern, source] of [
    ["kept.example", "{f}.{last}", "verified"],
    ["seen.example", "{last}.{first}", "website"],
  ] as const) {
    await app.emailDomainStatus.create({
      data: {
        ...{ id: `eds_${domain.split(".")[0]}`, domain, catchAll: false, provider: source },
        ...{ checkedAt: at, expiresAt: at, pattern, patternSource: source, patternCheckedAt: at },
      },
    });
  }
  await asRole("owner").$executeRawUnsafe(migrationCopy());
  assert.deepEqual(await stored("kept.example"), [["{f}.{last}", 1, at.toISOString(), null]]);
  assert.deepEqual(await stored("seen.example"), [["{last}.{first}", 0, null, at.toISOString()]]);
  assert.deepEqual(await guesses("kept.example", 3), ["j.doe@kept.example"]);
  assert.deepEqual(await guesses("seen.example", 3), ["doe.jane@seen.example"]);
});

test("the website source: contact and team pages read, the lead's own address from a footer's mailto a candidate, the domain's pattern seen from the team page, the colleagues' and role addresses dropped; no domain, no read", async () => {
  const answer = await websiteEmailSource.run(input("acme.example"), context);
  assert.deepEqual(answer, { found: true, candidates: [{ address: "jane.doe@acme.example" }] });
  const [row, ...more] = await stored("acme.example");
  assert.deepEqual([row?.slice(0, 3), more], [["{first}.{last}", 0, null], []]);
  assert.ok(!JSON.stringify(await app.emailDomainPattern.findMany({})).includes("@"));
  const other = await websiteEmailSource.run(input("acme.example", 3, "Ann", "Lee"), context);
  assert.deepEqual(other, { found: false, outcome: "pattern_found" });
  assert.deepEqual(await websiteEmailSource.run(input(""), context), { found: false });
});
