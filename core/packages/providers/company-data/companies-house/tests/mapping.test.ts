// The companies-house adapter offline (../README.md "Tests"), on the register's answers served on
// 127.0.0.1 (world.ts), never the real API: the port's contract suite; every row of the README's
// mapping table from the one active company whose name matches, the requests read back; no call
// without a GB hint or a .uk domain, or without a name; a dissolved company, two matches, none, a
// profile no longer active, a SIC code off the table; the rate limit; the pattern's redirect, bound
// and timeout; no key in a URL, no input or key leaked; the adapter as a host starts it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { companyDataCases } from "../../contract.ts";
import { companyDataPort } from "../../port.ts";
import {
  checkPattern,
  FAILURES,
  failuresSeen,
  leaked,
  mappedFields,
  startedIn,
  startVendor,
  vendorWorld,
} from "../../tests/fixtures/vendor.ts";
import { MAX_ANSWER_BYTES, TIMEOUT_MS } from "../constants.ts";
import { companiesHouseCompanyData } from "../index.ts";
import { SIC_2007 } from "../sic-2007.ts";
import { FACTS, NAME, route } from "./world.ts";

/** A made-up key: the register here is local. */
const KEY = "local-companies-house-key-0123";
const vendor = await startVendor(route);
after(() => vendor.close());
const options = { apiKey: KEY, apiUrl: vendor.origin };
const register = bindPort(companyDataPort, companiesHouseCompanyData(options), {
  adapter: "companies-house",
});
const since = () => vendor.requests.length;
const found = { result: "found", company: FACTS };
const notFound = { result: "not_found" };

contractSuite(
  companyDataPort,
  {
    port: companyDataPort,
    name: "companies-house",
    requires: [],
    create: () => companiesHouseCompanyData(options),
  },
  companyDataCases(
    vendorWorld(
      vendor,
      { lookup: { name: NAME, countryHint: "GB" }, facts: FACTS },
      { name: "Unknown Harbor", countryHint: "GB" },
    ),
  ),
);

describe("the companies-house adapter on the register's answers", () => {
  it("maps every row of the README's table from the one active company whose name matches; its requests carry the name, then the number, and the key in HTTP basic only", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.deepEqual(mappedFields(readme).toSorted(), Object.keys(FACTS).toSorted());
    assert.equal(SIC_2007.size, 731);
    const first = since();
    const lookup = {
      name: NAME,
      domain: "copper-harbor.co.uk",
      linkedinUrl: "https://www.linkedin.com/company/copper-harbor-labs",
    };
    assert.deepEqual(await register.lookupCompany(lookup), found);
    const [search, company, ...more] = vendor.requests.slice(first);
    assert.equal(more.length, 0);
    const basic = `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`;
    for (const request of [search, company]) {
      assert.deepEqual([request?.method, request?.body], ["GET", ""]);
      assert.equal(request?.headers.authorization, basic);
      assert.ok(!request?.url.includes(KEY), "the key in no URL");
      assert.deepEqual(leaked(["copper-harbor.co", "linkedin"], [request?.url]), []);
    }
    assert.deepEqual(
      [search?.path, search?.query],
      ["/search/companies", { q: NAME, items_per_page: "20" }],
    );
    assert.deepEqual([company?.path, company?.query], ["/company/01234567", {}]);
  });

  it("no call without a GB hint or a .uk domain, or without a name", async () => {
    const first = since();
    const lookups = [
      { name: NAME },
      { name: NAME, countryHint: "IE" },
      { name: NAME, domain: "copper-harbor.example" },
      { name: NAME, domain: "copper-harbor.uk.example", countryHint: "US" },
      { domain: "copper-harbor.co.uk", countryHint: "GB" },
      { linkedinUrl: "https://www.linkedin.com/company/copper-harbor-labs", countryHint: "GB" },
    ];
    for (const lookup of lookups) {
      assert.deepEqual(await register.lookupCompany(lookup), notFound, JSON.stringify(lookup));
    }
    assert.equal(since(), first, "no call");
    assert.deepEqual(await register.lookupCompany({ name: NAME, domain: "harbor.uk" }), found);
  });

  it("a dissolved company, two active matches, none and a profile no longer active are not_found; a SIC code off the table leaves the industry out", async () => {
    const lookups = [
      ["Dissolved Harbor", notFound, 1],
      ["Twin Harbor", notFound, 1],
      ["Unknown Harbor", notFound, 1],
      ["Stale Harbor", notFound, 2],
      ["Odd Harbor", { result: "found", company: { country: "GB" } }, 2],
    ] as const;
    for (const [name, answer, requests] of lookups) {
      const first = since();
      assert.deepEqual(await register.lookupCompany({ name, countryHint: "GB" }), answer, name);
      assert.equal(since() - first, requests, name);
    }
  });

  it("the rate limit, 600 requests in 5 minutes, is company_data_rate_limited: Retry-After's seconds, else the window's 300", async () => {
    vendor.answerNext({ status: 429 });
    const error = await register.lookupCompany({ name: NAME, countryHint: "GB" }).catch((e) => e);
    assert.ok(isAppError(error), String(error));
    assert.deepEqual(
      [error.code, error.details],
      ["company_data_rate_limited", { retryAfterSec: 300 }],
    );
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, no answer within 10 s given up: company_data_provider_error", async (t) => {
    const lookup = () => register.lookupCompany({ name: NAME, countryHint: "GB" });
    await checkPattern(t, vendor, lookup, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [262_144, 10_000]);
  });

  it("no key in a URL; no input's value and no key in an error or a log line", async () => {
    const lookups = [
      { name: NAME, countryHint: "GB" },
      { name: NAME, domain: "copper-harbor.co.uk" },
    ];
    const seen = await failuresSeen(register, vendor, lookups, Object.values(FAILURES));
    const base64 = Buffer.from(`${KEY}:`).toString("base64");
    assert.deepEqual(leaked([NAME, "copper-harbor", KEY, base64], seen), []);
    assert.ok(vendor.requests.every((request) => !request.url.includes(KEY)));
  });
});

test("the adapter as a host starts it: open data, no allowance unless set, COMPANIES_HOUSE_API_KEY required", async () => {
  const module = import.meta.resolve("../index.ts");
  const empty = { COMPANIES_HOUSE_API_KEY: "", COMPANIES_HOUSE_ALLOWANCE: "" };
  assert.deepEqual(await startedIn(module, "companiesHouseAdapter", empty), {
    openData: true,
    allowance: null,
    created: "config_invalid",
  });
  const set = { COMPANIES_HOUSE_API_KEY: KEY, COMPANIES_HOUSE_ALLOWANCE: "100000/month" };
  assert.deepEqual(await startedIn(module, "companiesHouseAdapter", set), {
    openData: true,
    allowance: { calls: 100_000, per: "month" },
    created: "created",
  });
});
