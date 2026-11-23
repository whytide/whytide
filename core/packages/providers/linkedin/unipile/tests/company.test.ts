// getCompany on Unipile, offline (README.md "Tests"; gamma-en-060): unipileLinkedin() against a
// node:http server of the test's own on 127.0.0.1, answering Unipile's company profile from the
// synthetic fixture fixtures/company-profile.json (shaped like Unipile's documentation, never
// recorded) or a variant of it the test builds, and recording each request. The mapped facts and
// nothing else of the answer; the headquarters' country by code or by name; a bare website, a long
// description, a missing fact or a band without its end; the slug and the number asked as they are;
// a 404, a disconnected account and an answer off the shape as the port's codes, with nothing of the
// body in them. The key and the secrets are made up for the run.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { linkedinPort } from "../../port.ts";
import { unipileLinkedin } from "../index.ts";

const KEY = randomBytes(24).toString("base64url");
const NOW = Date.parse("2026-11-13T09:00:00.000Z");
const ACCOUNT = "fixture-account";
const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
const PROFILE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "company-profile.json"), "utf8"),
) as Record<string, unknown>;
const MARKER = "fixture-body-marker";

/** The next answer: a body of the test's, and its status; none, the fixture with 200. */
let next: { status: number; body: unknown } | undefined;
const received: { path: string; query: Record<string, string>; key: unknown }[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  received.push({
    path: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams),
    key: request.headers["x-api-key"],
  });
  const { status, body } = next ?? { status: 200, body: PROFILE };
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  next = undefined;
  received.length = 0;
});
const linkedin = bindPort(
  linkedinPort,
  unipileLinkedin({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: KEY,
    webhookSecret: randomBytes(32).toString("hex"),
    cursorSecret: randomBytes(32).toString("base64url"),
    now: () => NOW,
  }),
  { adapter: "unipile" },
);
const read = (companyUrl = PAGE) =>
  linkedin.getCompany({ providerAccountRef: ACCOUNT, companyUrl });
/** The fixture with some keys changed, or dropped where the value is undefined. */
const variant = (changes: Record<string, unknown>) => ({
  status: 200,
  body: Object.fromEntries(
    Object.entries({ ...PROFILE, ...changes }).filter(([, value]) => value !== undefined),
  ),
});
const fails = (code: string) => (error: unknown) => {
  assert.ok(isAppError(error) && error.code === code, `${code}, not ${String(error)}`);
  const said = JSON.stringify([error.message, error.details]);
  assert.ok(!said.includes(MARKER) && !said.includes(KEY), said);
  return true;
};

test("getCompany asks Unipile's company profile by the page's slug for the account, and answers the mapped business facts only", async () => {
  assert.deepEqual(await read(), {
    companyUrl: PAGE,
    name: "Copper Harbor Labs",
    website: "https://www.copperharbor.example/about",
    industry: "Software Development",
    employeeCount: 140,
    employeeRange: { from: 51, to: 200 },
    headquartersCountry: "GB",
    description: `${MARKER}: a synthetic company that makes harbour software.`,
    foundedYear: 2012,
    fetchedAt: new Date(NOW),
  });
  assert.deepEqual(received, [
    {
      path: "/api/v1/linkedin/company/copper-harbor-labs",
      query: { account_id: ACCOUNT },
      key: KEY,
    },
  ]);
});

test("a page by its number, with a trailing slash, is asked as it is", async () => {
  await read("https://www.linkedin.com/company/1000002/");
  assert.equal(received[0]?.path, "/api/v1/linkedin/company/1000002");
});

test("the headquarters' country: a code kept, an English name mapped, an unknown one left out; no headquarters, none", async () => {
  const hq = (country: string) => [
    { is_headquarter: false, country: "FR", city: "Lyon", street: [] },
    { is_headquarter: true, country, city: "Bristol", street: [] },
  ];
  const countries = [
    [hq("United Kingdom"), "GB"],
    [hq("de"), "DE"],
    [hq("Atlantis"), undefined],
    [[{ is_headquarter: false, country: "FR", city: "Lyon", street: [] }], undefined],
    [[], undefined],
  ] as const;
  for (const [locations, expected] of countries) {
    next = variant({ locations });
    assert.equal((await read()).headquartersCountry, expected, JSON.stringify(locations));
  }
});

test("a bare website is read as https, a description cut to 2,000 characters, a band without its end kept open, a missing fact left out", async () => {
  next = variant({
    website: "copperharbor.example",
    description: "a".repeat(2500),
    employee_count_range: { from: 10001 },
    employee_count: undefined,
    industry: [],
    foundation_date: "not a date",
  });
  const company = await read();
  assert.equal(company.website, "https://copperharbor.example/");
  assert.equal(company.description, "a".repeat(2000));
  assert.deepEqual(company.employeeRange, { from: 10001 });
  for (const key of ["employeeCount", "industry", "foundedYear"]) {
    assert.ok(!(key in company), key);
  }
  next = variant({ website: "javascript:alert(1)", employee_count_range: { from: 200, to: 51 } });
  const odd = await read();
  assert.ok(!("website" in odd));
  assert.deepEqual(odd.employeeRange, { from: 200 });
});

test("a 404 is linkedin_not_found, a disconnected account linkedin_account_disconnected, an answer without its name linkedin_provider_error; nothing of the body kept", async () => {
  next = { status: 404, body: { type: "errors/resource_not_found", detail: MARKER } };
  await assert.rejects(read(), fails("linkedin_not_found"));
  next = { status: 401, body: { type: "errors/disconnected_account", detail: MARKER } };
  await assert.rejects(read(), fails("linkedin_account_disconnected"));
  next = variant({ name: undefined });
  await assert.rejects(read(), fails("linkedin_provider_error"));
});

test("a member's page is linkedin_input_invalid, and nothing is asked of Unipile", async () => {
  await assert.rejects(read("https://www.linkedin.com/in/ada-example"), (error) => {
    assert.ok(isAppError(error) && error.code === "linkedin_input_invalid");
    return true;
  });
  assert.equal(received.length, 0);
});
