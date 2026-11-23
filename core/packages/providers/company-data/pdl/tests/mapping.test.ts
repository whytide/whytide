// The pdl adapter's mapping tests (../README.md "Tests"), offline: pdlCompanyData() against a vendor
// of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the synthetic fixtures
// of fixtures/ (shaped like People Data Labs' documentation, never recorded) and recording each
// request. No vendor is called; the key is made up for the run. First the port's contract suite in
// that world; then the request, each row of the README's mapping table, each answer's code, the
// pattern's redirect, bound and timeout, and what a run leaves behind. The config's checks run in a
// child process: it is read at the adapter's import.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { DESCRIPTION_MAX } from "../../constants.ts";
import {
  type CompanyDataFailure,
  companyDataCases,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
} from "../../contract.ts";
import { countryOf } from "../../normalize.ts";
import { type CompanyFacts, type CompanyLookup, companyDataPort } from "../../port.ts";
import { traces } from "../../tests/fixtures/traces.ts";
import {
  type Answer,
  checkPattern,
  closedOrigin,
  leaked,
  startVendor,
  vendorWorld,
} from "../../tests/fixtures/vendor.ts";
import { MAX_ANSWER_BYTES, TIMEOUT_MS } from "../constants.ts";
import { pdlAdapter, pdlCompanyData } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
const MIN_LIKELIHOOD = 6;
const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
const DOMAIN = "copper-harbor.example";
const NAME = "Copper Harbor Labs";
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const MATCH: Record<string, unknown> = fixture("match.json");
const NOT_FOUND_ANSWER: Answer = { status: 404, body: fixture("not-found.json") };
/** match.json in the port's words: every row of the mapping table. */
const FACTS: CompanyFacts = {
  domain: DOMAIN,
  linkedinUrl: PAGE,
  industry: "computer software",
  employeeCount: 42,
  country: "GB",
  description: "copper harbor labs is a synthetic company of the contract suite.",
  foundedYear: 2019,
};
/** An answer matching match.json with `changes`. */
const matching = (changes: Record<string, unknown>): Answer => ({ body: { ...MATCH, ...changes } });
const found = (company: CompanyFacts) => ({ result: "found", company });
const NOT_FOUND = { result: "not_found" };

const vendor = await startVendor(({ query }) =>
  query.profile === PAGE || query.website === DOMAIN || query.name === NAME
    ? { body: MATCH }
    : NOT_FOUND_ANSWER,
);
after(() => vendor.close());

/** The adapter on the local vendor, as create() makes it on PDL's host. */
const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  pdlCompanyData({
    origin,
    apiKey: KEY,
    minLikelihood: MIN_LIKELIHOOD,
    now: () => NOW,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const local = { port: companyDataPort, name: pdlAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(companyDataPort, implementation, { adapter: pdlAdapter.name });
const pdl = bound();

const error = (status: number, type: string) => ({
  status,
  body: { status, error: { type, message: `A ${type}.` } },
});
/** PDL's answer for each of the contract's codes. */
const FAILURES: Readonly<Record<CompanyDataFailure, Answer>> = {
  company_data_rate_limited: {
    ...error(429, "rate_limit_error"),
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
  },
  company_data_allowance_spent: error(402, "payment_required"),
  company_data_unauthorized: error(401, "authentication_error"),
  company_data_provider_error: error(PROVIDER_ERROR_STATUS, "api_error"),
};
contractSuite(
  companyDataPort,
  local,
  companyDataCases(
    vendorWorld(
      vendor,
      { lookup: { linkedinUrl: PAGE }, facts: FACTS },
      { domain: "unknown-company.example" },
      FAILURES,
    ),
  ),
);

/** The lookup's answer to `answer`, served next. */
async function answering(answer: Answer, lookup: CompanyLookup = { name: NAME }) {
  vendor.answerNext(answer);
  return pdl.lookupCompany(lookup);
}
const failsWith = (code: string, details: Record<string, unknown>) => (caught: unknown) => {
  assert.ok(isAppError(caught), String(caught));
  assert.deepEqual([caught.code, caught.details], [code, details]);
  return true;
};

describe("the pdl adapter against a local vendor", () => {
  it("sends Company Enrichment one company key, the LinkedIn page, else the website, else the name, with min_likelihood; the key in X-Api-Key only", async () => {
    const lookups: (readonly [CompanyLookup, Record<string, string>])[] = [
      [{ linkedinUrl: PAGE }, { profile: PAGE }],
      [{ domain: DOMAIN }, { website: DOMAIN }],
      [{ name: NAME }, { name: NAME }],
      [{ linkedinUrl: PAGE, domain: DOMAIN, name: NAME, countryHint: "GB" }, { profile: PAGE }],
      [{ domain: DOMAIN, name: NAME }, { website: DOMAIN }],
      [{ name: NAME, countryHint: "GB" }, { name: NAME }],
    ];
    for (const [lookup, key] of lookups) {
      const before = vendor.requests.length;
      assert.deepEqual(await pdl.lookupCompany(lookup), found(FACTS));
      const requests = vendor.requests.slice(before);
      const query = { ...key, min_likelihood: String(MIN_LIKELIHOOD) };
      const label = JSON.stringify(lookup);
      assert.deepEqual(
        requests.map(({ method, path, query }) => [method, path, query]),
        [["GET", "/v5/company/enrich", query]],
        label,
      );
      const { "x-api-key": apiKey, ...headers } = requests[0]?.headers ?? {};
      assert.equal(apiKey, KEY, label);
      const rest = JSON.stringify(headers).toLowerCase();
      for (const value of [KEY, NAME, DOMAIN, "authorization", "cookie"]) {
        assert.ok(!rest.includes(value.toLowerCase()), `${label}: ${value} in another header`);
      }
    }
  });

  it("no match, a 404, is not_found", async () => {
    assert.deepEqual(await answering(NOT_FOUND_ANSWER), NOT_FOUND);
  });

  it("a weak match, below min_likelihood, is not_found, whatever the vendor sends back; min_likelihood itself is a match", async () => {
    assert.deepEqual(await answering(matching({ likelihood: 3 })), NOT_FOUND);
    assert.deepEqual(await answering(matching({ likelihood: "9" })), NOT_FOUND, "in text");
    assert.deepEqual(await answering(matching({ likelihood: null })), NOT_FOUND, "none");
    const atLeast = await answering(matching({ likelihood: MIN_LIKELIHOOD }));
    assert.deepEqual(atLeast, found(FACTS));
  });

  it("a range without a count: the size's canonical range, the open one, none for a size off the list", async () => {
    const { employeeCount: _count, ...rest } = FACTS;
    const sizes = [
      ["51-200", { employeeRange: { from: 51, to: 200 } }],
      ["1-10", { employeeRange: { from: 1, to: 10 } }],
      ["10001+", { employeeRange: { from: 10_001 } }],
      ["200-51", {}],
      ["large", {}],
      [null, {}],
    ] as const;
    for (const [size, range] of sizes) {
      for (const employee_count of [null, 0]) {
        const answer = await answering(matching({ employee_count, size }));
        assert.deepEqual(answer, found({ ...rest, ...range }), `${size}, ${employee_count}`);
      }
    }
  });

  it("a country given by name, in lower case, as its code; every name of PDL's canonical list has one of its own; a name it cannot tell, no country", async () => {
    const { country: _country, ...rest } = FACTS;
    const countries = [
      ["united states", "US"],
      ["côte d'ivoire", "CI"],
      ["the gambia", "GM"],
      ["atlantis", undefined],
    ] as const;
    for (const [name, country] of countries) {
      const location = { ...(MATCH.location as object), country: name };
      const answer = await answering(matching({ location }));
      assert.deepEqual(answer, found(country ? { ...rest, country } : rest), name);
    }
    assert.deepEqual(await answering(matching({ location: null })), found(rest), "no location");
    const canonical: string[] = fixture("countries.json");
    const codes = canonical.map((name) => [name, countryOf(name)] as const);
    assert.deepEqual(
      codes.filter(([, code]) => code === undefined).map(([name]) => name),
      [],
      "every name has a code",
    );
    assert.equal(new Set(codes.map(([, code]) => code)).size, canonical.length, "each its own");
  });

  it("values off the port's forms are left out, never the whole answer, and a long summary cut whole characters at 2,000; a record with nothing the port takes is not_found", async () => {
    const offForm = {
      website: "not a website",
      linkedin_url: "linkedin.com/in/ada-example",
      industry: "",
      founded: 0,
      summary: "   ",
    };
    const { employeeCount, country } = FACTS;
    assert.deepEqual(await answering(matching(offForm)), found({ employeeCount, country }));
    const summary = `${"y".repeat(DESCRIPTION_MAX - 1)}😀 and more`;
    const cut = await answering(matching({ summary }));
    assert.deepEqual(cut, found({ ...FACTS, description: "y".repeat(DESCRIPTION_MAX - 1) }));
    const nothing = Object.fromEntries(Object.keys(MATCH).map((key) => [key, null]));
    const record = { ...nothing, status: 200, likelihood: 9, display_name: NAME };
    assert.deepEqual(await answering({ body: record }), NOT_FOUND);
  });

  it("the quota answer, a 402, is company_data_allowance_spent; a 429 the rate limit, Retry-After's seconds or date, else 60 s", async () => {
    const spent = failsWith("company_data_allowance_spent", { status: 402 });
    await assert.rejects(answering(error(402, "payment_required")), spent);
    const waits = [
      [{}, 60],
      [{ "retry-after": "30" }, 30],
      [{ "retry-after": new Date(NOW + 90_000).toUTCString() }, 90],
    ] as const;
    for (const [headers, retryAfterSec] of waits) {
      const limited = failsWith("company_data_rate_limited", { retryAfterSec });
      await assert.rejects(answering({ ...error(429, "rate_limit_error"), headers }), limited);
    }
  });

  it("a 403 is unauthorized; a 400 and a 500 the provider error with its status; an answer not JSON not_json; a list off_shape", async () => {
    const forbidden = failsWith("company_data_unauthorized", { status: 403 });
    await assert.rejects(answering(error(403, "forbidden")), forbidden);
    for (const status of [400, 500]) {
      const failed = failsWith("company_data_provider_error", { status });
      await assert.rejects(answering(error(status, "invalid_request_error")), failed);
    }
    const notJson = failsWith("company_data_provider_error", { status: 200, reason: "not_json" });
    await assert.rejects(answering({ body: "<html>" }), notJson);
    const offShape = failsWith("company_data_provider_error", { reason: "off_shape" });
    await assert.rejects(answering({ body: [MATCH] }), offShape);
  });

  it("a redirect is never followed, an answer past 1 MiB never read whole, no answer within 10 s given up, a refused connection: company_data_provider_error", async (t) => {
    const lookup = () => pdl.lookupCompany({ name: NAME });
    await checkPattern(t, vendor, lookup, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [1024 * 1024, 10_000]);
    const closed = bound(onVendor(await closedOrigin()));
    const refused = { reason: "network", code: "ECONNREFUSED" };
    const network = failsWith("company_data_provider_error", refused);
    await assert.rejects(closed.lookupCompany({ name: NAME }), network);
  });

  it("no key and no input's value in an error, a log line, the console or a metric label", async (t) => {
    const page = "https://www.linkedin.com/company/quillmarsh-tide";
    const domain = "quillmarsh-tide.example";
    const name = "Quillmarsh Tide Holdings";
    const echo = (status: number) => ({
      status,
      body: { status, error: { type: "echo", message: `${KEY} quillmarsh ${name}` } },
    });
    const answers: (readonly [Answer, CompanyLookup])[] = [
      [FAILURES.company_data_rate_limited, { linkedinUrl: page }],
      [echo(402), { domain }],
      [echo(401), { name }],
      [echo(500), { name, countryHint: "GB" }],
      [{ status: 302, headers: { location: `${vendor.origin}/?api_key=${KEY}` } }, { domain }],
      [{ body: `quillmarsh ${KEY}` }, { linkedinUrl: page }],
    ];
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...answers.map(
        ([answer, lookup]) =>
          () =>
            answering(answer, lookup),
      ),
      () => {
        vendor.answerNext({ silent: true });
        return slow.lookupCompany({ name });
      },
      () => closed.lookupCompany({ domain }),
    ];
    const { errors, seen, logged, counted } = await traces(t, calls);
    assert.equal(errors.length, calls.length, "every call failed");
    assert.equal(logged, calls.length, "every failure was logged");
    assert.ok(counted > 0, "the calls were counted");
    assert.deepEqual(leaked([KEY, page, domain, name, "quillmarsh"], seen), []);
  });

  it("from the registry: the free plan's allowance, 100 a month, unless PDL_ALLOWANCE sets one; PDL_MIN_LIKELIHOOD 6 unless set, 1 to 10; not open data; PDL_API_KEY required at start", async () => {
    const script = [
      "try {",
      `  const { getAdapters } = await import(${JSON.stringify(import.meta.resolve("../../../registry.ts"))});`,
      `  const { companyDataPort } = await import(${JSON.stringify(import.meta.resolve("../../port.ts"))});`,
      `  const { pdlConfig } = await import(${JSON.stringify(import.meta.resolve("../config.ts"))});`,
      "  const [pdl] = await getAdapters(companyDataPort, ['pdl']);",
      "  console.log(JSON.stringify([pdl.allowance, pdl.openData, pdlConfig.PDL_MIN_LIKELIHOOD]));",
      "} catch (error) { console.log(error.code); }",
    ].join("\n");
    const startWith = (env: Record<string, string>) =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, APP_ENV: "test", PDL_ALLOWANCE: "", PDL_MIN_LIKELIHOOD: "", ...env },
      }).then(({ stdout }) => stdout.trim());
    const runs: Record<string, string>[] = [
      { PDL_API_KEY: KEY },
      { PDL_API_KEY: KEY, PDL_ALLOWANCE: "250/day", PDL_MIN_LIKELIHOOD: "8" },
      { PDL_API_KEY: KEY, PDL_ALLOWANCE: "lots" },
      { PDL_API_KEY: KEY, PDL_MIN_LIKELIHOOD: "11" },
      { PDL_API_KEY: "" },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '[{"calls":100,"per":"month"},false,6]',
      '[{"calls":250,"per":"day"},false,8]',
      "config_invalid",
      "config_invalid",
      "config_invalid",
    ]);
  });
});
