// The safety cases of the free email sources (gamma-en-085, send path; docs/security.md "The free
// email sources"), run by `pnpm -F enrichment test:safety`: other people's addresses on a company's
// site never leave the website source, and the domain keeps a pattern's name only, never an address
// or a name; a domain recorded catch-all gets no guess; the reply source proposes only the lead's own
// address of a message holding several, and nothing without inbox's reader. Only a verifier's `valid`
// keeps any of them: the lookup's rule, tests/safety/addresses.test.ts and the worker's lookup test.
// gamma-rf-030: the domain's patterns are rows of email_domain_patterns, still a pattern's name only;
// a domain recorded catch-all gets no guess even with patterns known, verified or seen.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

const HTML = { "content-type": "text/html; charset=utf-8" };
const TEAM = `<!doctype html><html><body><p>John Smith, john.smith@acme.example</p>
  <p>Mia Wong, mwong@acme.example</p><p>info@acme.example</p></body></html>`;
const site = createServer((req, res) => {
  if (req.url === "/robots.txt") return res.writeHead(200).end("User-agent: *\nAllow: /\n");
  if (req.url === "/acme/") res.writeHead(200, HTML).end(TEAM);
  else res.writeHead(404).end();
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
const { patternSource } = await import("../../domain/sources/pattern.ts");
const { replySource, useAddressesGiven } = await import("../../domain/sources/reply.ts");
const { websiteEmailSource } = await import("../../domain/sources/website/email.ts");
const { useSiteHome } = await import("../../testing/index.ts");

withTestDb();
const app = asRole("app");
const WS = "wsp_enrichment_email_safety";
const PERSON = "per_email_safety";
const context = {
  tenant: <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: WS, principal: servicePrincipal("enrichment_safety") }, fn, {
      client: app,
    }),
};
useSiteHome((domain) => new URL(`${origin}/${domain.split(".")[0]}/`));
const input = (companyDomain: string) => ({
  workspaceId: WS,
  personId: PERSON,
  firstName: "Jane",
  lastName: "Doe",
  companyDomain,
  room: 3,
});

test("a team page's other addresses never leave the website source: no candidate of theirs, and the domain keeps a pattern's name only, never an address or a name", async () => {
  const answer = await websiteEmailSource.run(input("acme.example"), context);
  assert.deepEqual(answer, { found: false, outcome: "pattern_found" });
  const rows = await app.emailDomainPattern.findMany({});
  assert.deepEqual(
    rows.map(({ domain, pattern, verifiedCount }) => [domain, pattern, verifiedCount]),
    [["acme.example", "{first}.{last}", 0]],
  );
  const stored = JSON.stringify([rows, await app.emailDomainStatus.findMany({})]);
  for (const value of ["@", "john", "smith", "mia", "wong", "info"]) {
    assert.ok(!stored.toLowerCase().includes(value), `a domain's row holds "${value}"`);
  }
  assert.deepEqual(await app.contactPoint.findMany({}), []);
  assert.deepEqual(await app.enrichmentCacheEntry.findMany({}), []);
});

test("a domain recorded catch-all gets no guess", async () => {
  await app.emailDomainStatus.create({
    data: {
      ...{ id: "eds_safety_catch_all", domain: "loose.example", catchAll: true, provider: "fake" },
      ...{ checkedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) },
    },
  });
  assert.deepEqual(await patternSource.run(input("loose.example"), context), {
    found: false,
    outcome: "catch_all_domain",
  });
});

test("a domain recorded catch-all gets no guess, even with patterns known: verified ones and a site's (gamma-rf-030)", async () => {
  const at = new Date();
  await app.emailDomainStatus.create({
    data: {
      ...{ id: "eds_safety_known", domain: "known.example", catchAll: true, provider: "fake" },
      ...{ checkedAt: at, expiresAt: new Date(at.getTime() + 86_400_000) },
    },
  });
  await app.emailDomainPattern.createMany({
    data: [
      { domain: "known.example", pattern: "{first}.{last}", verifiedCount: 5, lastVerifiedAt: at },
      { domain: "known.example", pattern: "{f}{last}", verifiedCount: 1, lastVerifiedAt: at },
      { domain: "known.example", pattern: "{first}", siteSeenAt: at },
    ],
  });
  for (const room of [1, 3]) {
    assert.deepEqual(await patternSource.run({ ...input("known.example"), room }, context), {
      found: false,
      outcome: "catch_all_domain",
    });
  }
});

test("the reply source proposes only the lead's own of a message holding several, never a colleague's, and nothing without inbox's reader (which never reads the workspace's own messages: inbox's tests/addresses-given-by.test.ts)", async () => {
  useAddressesGiven(undefined);
  assert.deepEqual(await replySource.run(input("acme.example"), context), { found: false });
  const asked: string[] = [];
  useAddressesGiven(async (personId) => {
    asked.push(personId);
    return [
      ["tom.ray@acme.example", "jane.doe@acme.example"],
      ["sam@ourco.example", "mia@acme.example"],
    ];
  });
  try {
    assert.deepEqual(await replySource.run(input("acme.example"), context), {
      found: true,
      candidates: [{ address: "jane.doe@acme.example" }],
    });
    assert.deepEqual(asked, [PERSON]);
  } finally {
    useAddressesGiven(undefined);
  }
});
