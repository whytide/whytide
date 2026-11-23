// The google-kg adapter offline (../README.md "Tests"), on Google's answers served on 127.0.0.1
// (world.ts), never the real API: the port's contract suite on Google's own failures; every row of
// the README's mapping table from the one organization whose name matches, the request read back;
// a name that does not match, two that do, none, a match with no fact, and no name at all; Google's
// error model; the pattern's redirect, bound and timeout; no key in a URL, no input or key leaked;
// the adapter as a host starts it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it, test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { companyDataCases } from "../../contract.ts";
import { companyDataPort } from "../../port.ts";
import {
  type Answer,
  checkPattern,
  failuresSeen,
  leaked,
  mappedFields,
  startedIn,
  startVendor,
  vendorWorld,
} from "../../tests/fixtures/vendor.ts";
import { MAX_ANSWER_BYTES, TIMEOUT_MS } from "../constants.ts";
import { googleKgCompanyData } from "../index.ts";
import { FACTS, GOOGLE_FAILURES, NAME, route } from "./world.ts";

/** A made-up key: the vendor here is local. */
const KEY = "local-google-key-0123456789";
const vendor = await startVendor(route);
after(() => vendor.close());
const options = { apiKey: KEY, searchUrl: `${vendor.origin}/v1/entities:search` };
const googleKg = bindPort(companyDataPort, googleKgCompanyData(options), { adapter: "google-kg" });
const since = () => vendor.requests.length;
const notFound = { result: "not_found" };

contractSuite(
  companyDataPort,
  {
    port: companyDataPort,
    name: "google-kg",
    requires: [],
    create: () => googleKgCompanyData(options),
  },
  companyDataCases(
    vendorWorld(
      vendor,
      { lookup: { name: NAME }, facts: FACTS },
      { name: "Unknown Harbor" },
      GOOGLE_FAILURES,
    ),
  ),
);

describe("the google-kg adapter on Google's answers", () => {
  it("maps every row of the README's table from the one organization whose name matches; its request carries the name and the key, in X-Goog-Api-Key only", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.deepEqual(mappedFields(readme).toSorted(), Object.keys(FACTS).toSorted());
    const first = since();
    const lookup = {
      name: NAME,
      domain: "copper-harbor.example",
      linkedinUrl: "https://www.linkedin.com/company/copper-harbor-labs",
      countryHint: "GB",
    };
    assert.deepEqual(await googleKg.lookupCompany(lookup), { result: "found", company: FACTS });
    const [request, ...more] = vendor.requests.slice(first);
    assert.equal(more.length, 0);
    assert.deepEqual(
      [request?.method, request?.path, request?.body],
      ["GET", "/v1/entities:search", ""],
    );
    assert.deepEqual(request?.query, { query: NAME, types: "Organization", limit: "5" });
    assert.equal(request?.headers["x-goog-api-key"], KEY);
    assert.ok(!request?.url.includes(KEY), "the key in no URL");
    assert.deepEqual(leaked(["copper-harbor", "GB"], [request?.url, request?.headers]), []);
  });

  it("a name that does not match, two that match, none, and a match with no fact are not_found; without a name, no call", async () => {
    for (const name of ["Copper Harbor", "Twin Harbor", "Unknown Harbor", "Bare Harbor"]) {
      assert.deepEqual(await googleKg.lookupCompany({ name }), notFound, name);
    }
    const first = since();
    const keys = {
      domain: "copper-harbor.example",
      linkedinUrl: "https://www.linkedin.com/company/copper-harbor-labs",
    };
    assert.deepEqual(await googleKg.lookupCompany(keys), notFound);
    assert.equal(since(), first, "no call");
  });

  it("Google's error models: a daily quota spent, a per-minute limit, an invalid key, in the current model and the older one; a 403 alone; a 429 with no Retry-After", async () => {
    const codeOf = async (answer: Answer) => {
      vendor.answerNext(answer);
      const error = await googleKg.lookupCompany({ name: NAME }).catch((caught: unknown) => caught);
      assert.ok(isAppError(error), String(error));
      return [error.code, error.details];
    };
    const older = (status: number, reason: string) => ({
      status,
      body: { error: { code: status, errors: [{ domain: "usageLimits", reason }] } },
    });
    const answers: readonly (readonly [Answer, string, Record<string, unknown>])[] = [
      [
        GOOGLE_FAILURES.company_data_allowance_spent,
        "company_data_allowance_spent",
        { status: 429 },
      ],
      [older(403, "dailyLimitExceeded"), "company_data_allowance_spent", { status: 403 }],
      [GOOGLE_FAILURES.company_data_unauthorized, "company_data_unauthorized", { status: 400 }],
      [older(400, "keyInvalid"), "company_data_unauthorized", { status: 400 }],
      [older(403, "userRateLimitExceeded"), "company_data_rate_limited", { retryAfterSec: 60 }],
      [{ status: 403, body: {} }, "company_data_unauthorized", { status: 403 }],
      [{ status: 429, body: "not JSON" }, "company_data_rate_limited", { retryAfterSec: 60 }],
      [{ status: 400, body: {} }, "company_data_provider_error", { status: 400 }],
    ];
    for (const [answer, code, details] of answers) {
      assert.deepEqual(await codeOf(answer), [code, details], JSON.stringify(answer));
    }
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, no answer within 10 s given up: company_data_provider_error", async (t) => {
    const lookup = () => googleKg.lookupCompany({ name: NAME });
    await checkPattern(t, vendor, lookup, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [262_144, 10_000]);
  });

  it("no key in a URL; no input's value and no key in an error or a log line", async () => {
    const lookups = [{ name: NAME }, { name: NAME, domain: "copper-harbor.example" }];
    const seen = await failuresSeen(googleKg, vendor, lookups, Object.values(GOOGLE_FAILURES));
    assert.deepEqual(leaked([NAME, "copper-harbor", KEY], seen), []);
    assert.ok(vendor.requests.every((request) => !request.url.includes(KEY)));
  });
});

test("the adapter as a host starts it: not open data, 100,000 calls a day unless set, GOOGLE_KG_API_KEY required", async () => {
  const module = import.meta.resolve("../index.ts");
  const empty = { GOOGLE_KG_API_KEY: "", GOOGLE_KG_ALLOWANCE: "" };
  assert.deepEqual(await startedIn(module, "googleKgAdapter", empty), {
    openData: false,
    allowance: { calls: 100_000, per: "day" },
    created: "config_invalid",
  });
  const set = { GOOGLE_KG_API_KEY: KEY, GOOGLE_KG_ALLOWANCE: "500/day" };
  assert.deepEqual(await startedIn(module, "googleKgAdapter", set), {
    openData: false,
    allowance: { calls: 500, per: "day" },
    created: "created",
  });
});
