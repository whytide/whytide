// The diffbot adapter's mapping tests (../README.md "Tests"), offline: diffbotCompanyData() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the synthetic
// fixtures of fixtures/ (shaped like Diffbot's documentation, never recorded) and recording each
// request. No vendor is called; the token is made up for the run. First the port's contract suite in
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
import { MAX_ANSWER_BYTES, MIN_SCORE, TIMEOUT_MS } from "../constants.ts";
import { diffbotAdapter, diffbotCompanyData } from "../index.ts";

const TOKEN = `token${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
const PAGE = "https://www.linkedin.com/company/copper-harbor-labs";
const DOMAIN = "copper-harbor.example";
const NAME = "Copper Harbor Labs";
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const MATCH = fixture("match.json");
const NO_MATCH = fixture("no-match.json");
/** match.json's Organization. */
const ENTITY: Record<string, unknown> = MATCH.data[0].entity;
/** match.json in the port's words: every row of the mapping table. */
const FACTS: CompanyFacts = {
  domain: DOMAIN,
  linkedinUrl: PAGE,
  industry: "Software Companies",
  employeeCount: 42,
  country: "GB",
  description: "Copper Harbor Labs is a synthetic company of the contract suite.",
  foundedYear: 2019,
};
/** An answer matching `entity` at `score`. */
const matching = (entity: object | null, score: unknown = 0.93): Answer => ({
  body: { ...MATCH, data: [{ score, esscore: 30, entity }] },
});
const found = (company: CompanyFacts) => ({ result: "found", company });
const NOT_FOUND = { result: "not_found" };

const vendor = await startVendor(({ query }) =>
  query.url === PAGE || query.url === DOMAIN || query.name === NAME
    ? { body: MATCH }
    : { body: NO_MATCH },
);
after(() => vendor.close());

/** The adapter on the local vendor, as create() makes it on Diffbot's host. */
const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  diffbotCompanyData({ origin, token: TOKEN, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const local = { port: companyDataPort, name: diffbotAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(companyDataPort, implementation, { adapter: diffbotAdapter.name });
const diffbot = bound();

/** Diffbot's answer for each of the contract's codes. */
const FAILURES: Readonly<Record<CompanyDataFailure, Answer>> = {
  company_data_rate_limited: {
    status: 429,
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
    body: { errorCode: 429, error: "Too many requests, please slow down." },
  },
  company_data_allowance_spent: { status: 429, body: { errorCode: 429, error: "Quota Exceeded" } },
  company_data_unauthorized: { status: 401, body: { code: 401, message: "Not authorized." } },
  company_data_provider_error: { status: PROVIDER_ERROR_STATUS },
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
  return diffbot.lookupCompany(lookup);
}
const failsWith = (code: string, details: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], [code, details]);
  return true;
};

describe("the diffbot adapter against a local vendor", () => {
  it("sends Enhance one company key, the LinkedIn page, else the domain, else the name, with the threshold and the token in the query, and nothing else", async () => {
    const lookups: (readonly [CompanyLookup, Record<string, string>])[] = [
      [{ linkedinUrl: PAGE }, { url: PAGE }],
      [{ domain: DOMAIN }, { url: DOMAIN }],
      [{ name: NAME }, { name: NAME }],
      [{ linkedinUrl: PAGE, domain: DOMAIN, name: NAME, countryHint: "GB" }, { url: PAGE }],
      [{ domain: DOMAIN, name: NAME }, { url: DOMAIN }],
      [{ name: NAME, countryHint: "GB" }, { name: NAME }],
    ];
    for (const [lookup, key] of lookups) {
      const before = vendor.requests.length;
      assert.deepEqual(await diffbot.lookupCompany(lookup), found(FACTS));
      const requests = vendor.requests.slice(before);
      const query = { type: "Organization", ...key, threshold: String(MIN_SCORE), token: TOKEN };
      const label = JSON.stringify(lookup);
      assert.deepEqual(
        requests.map(({ method, path, query }) => [method, path, query]),
        [["GET", "/kg/v3/enhance", query]],
        label,
      );
      const headers = JSON.stringify(requests[0]?.headers).toLowerCase();
      for (const value of [TOKEN, NAME, DOMAIN, "authorization", "cookie"]) {
        assert.ok(!headers.includes(value.toLowerCase()), `${label}: ${value} in a header`);
      }
    }
  });

  it("no match, an empty data list, is not_found", async () => {
    assert.deepEqual(await answering({ body: NO_MATCH }), NOT_FOUND);
  });

  it("a weak match, below MIN_SCORE, is not_found, whatever the vendor sends back; MIN_SCORE itself is a match", async () => {
    assert.deepEqual(await answering(matching(ENTITY, 0.31)), NOT_FOUND);
    assert.deepEqual(await answering(matching(ENTITY, "0.93")), NOT_FOUND, "a score in text");
    assert.deepEqual(await answering(matching(ENTITY, null)), NOT_FOUND, "no score");
    assert.deepEqual(await answering(matching(ENTITY, MIN_SCORE)), found(FACTS));
  });

  it("a range without a count: both bounds; the lower alone an open band; bounds that disagree, none", async () => {
    const { nbEmployees: _count, ...uncounted } = ENTITY;
    const { employeeCount: _facts, ...rest } = FACTS;
    const ranges = [
      [{ nbEmployeesMin: 11, nbEmployeesMax: 50 }, { employeeRange: { from: 11, to: 50 } }],
      [{ nbEmployeesMin: 10_001, nbEmployeesMax: null }, { employeeRange: { from: 10_001 } }],
      [{ nbEmployeesMin: 0, nbEmployeesMax: 1 }, { employeeRange: { from: 0, to: 1 } }],
      [{ nbEmployeesMin: 50, nbEmployeesMax: 11 }, {}],
      [{ nbEmployeesMin: undefined, nbEmployeesMax: 50 }, {}],
    ] as const;
    for (const [bounds, range] of ranges) {
      const answer = await answering(matching({ ...uncounted, ...bounds }));
      assert.deepEqual(answer, found({ ...rest, ...range }), JSON.stringify(bounds));
    }
  });

  it("a country given by name, Diffbot's or ICU's English one, in any case; a name it cannot tell, no country", async () => {
    const countries = [
      ["United States of America", "US"],
      ["People's Republic of China", "CN"],
      ["Côte d'Ivoire", "CI"],
      ["SOUTH KOREA", "KR"],
      ["Atlantis", undefined],
    ] as const;
    const { country: _country, ...rest } = FACTS;
    for (const [name, country] of countries) {
      const location = { country: { name, type: "AdministrativeArea" } };
      const answer = await answering(matching({ ...ENTITY, location }));
      assert.deepEqual(answer, found(country ? { ...rest, country } : rest), name);
    }
  });

  it("values off the port's forms are left out, never the whole answer; an Organization with nothing the port takes is not_found", async () => {
    const offForm = {
      homepageUri: "http://localhost:8080",
      linkedInUri: "linkedin.com/in/ada-example",
      industries: [""],
      foundingDate: { str: "dXXXX-XX-XX", precision: 0 },
      location: null,
      description: "x".repeat(DESCRIPTION_MAX + 5),
    };
    const { employeeCount } = FACTS;
    const description = "x".repeat(DESCRIPTION_MAX);
    assert.deepEqual(
      await answering(matching({ ...ENTITY, ...offForm })),
      found({ employeeCount, description }),
    );
    const pages = [
      ["https://uk.linkedin.com/company/copper-harbor-labs/about/", PAGE],
      ["linkedin.com/school/copper-harbor-academy", undefined],
      ["https://copper-harbor.example/company/copper", undefined],
    ] as const;
    for (const [linkedInUri, page] of pages) {
      const answer = await answering(matching({ industries: ["Logistics"], linkedInUri }));
      const facts = { industry: "Logistics", ...(page ? { linkedinUrl: page } : {}) };
      assert.deepEqual(answer, found(facts), linkedInUri);
    }
    const nothing = { name: NAME, ceo: { name: "Ada Example" }, industries: [] };
    assert.deepEqual(await answering(matching(nothing)), NOT_FOUND);
  });

  it("the quota answer: a 429 naming the quota or the credits, and a 402, are company_data_allowance_spent; another 429 is the rate limit, Retry-After's seconds or date, else 60 s", async () => {
    const spent = [
      { status: 429, body: { errorCode: 429, error: "429 Quota Exceeded" } },
      { status: 429, body: { code: 429, message: "Insufficient credits" } },
      { status: 402, body: {} },
    ];
    for (const answer of spent) {
      const details = { status: answer.status };
      await assert.rejects(answering(answer), failsWith("company_data_allowance_spent", details));
    }
    const limited = { status: 429, body: { errorCode: 429, error: "Too many requests" } };
    const waits = [
      [{}, 60],
      [{ "retry-after": "30" }, 30],
      [{ "retry-after": new Date(NOW + 90_000).toUTCString() }, 90],
    ] as const;
    for (const [headers, retryAfterSec] of waits) {
      await assert.rejects(
        answering({ ...limited, headers }),
        failsWith("company_data_rate_limited", { retryAfterSec }),
      );
    }
    await assert.rejects(
      answering({ status: 429, body: "Too many requests" }),
      failsWith("company_data_rate_limited", { retryAfterSec: 60 }),
      "a 429 that is not JSON",
    );
  });

  it("a 403 is unauthorized; a 500 the provider error with its status; an answer not JSON not_json; one without its data list off_shape", async () => {
    await assert.rejects(
      answering({ status: 403 }),
      failsWith("company_data_unauthorized", { status: 403 }),
    );
    await assert.rejects(
      answering({ status: 500 }),
      failsWith("company_data_provider_error", { status: 500 }),
    );
    const notJson = { status: 200, reason: "not_json" };
    await assert.rejects(
      answering({ body: "<html>" }),
      failsWith("company_data_provider_error", notJson),
    );
    const offShape = { reason: "off_shape" };
    for (const answer of [{ body: { hits: 0 } }, matching(null)]) {
      await assert.rejects(answering(answer), failsWith("company_data_provider_error", offShape));
    }
  });

  it("a redirect is never followed, an answer past 4 MiB never read whole, no answer within 10 s given up, a refused connection: company_data_provider_error", async (t) => {
    const lookup = () => diffbot.lookupCompany({ name: NAME });
    await checkPattern(t, vendor, lookup, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [4 * 1024 * 1024, 10_000]);
    const closed = bound(onVendor(await closedOrigin()));
    const refused = { reason: "network", code: "ECONNREFUSED" };
    await assert.rejects(
      closed.lookupCompany({ name: NAME }),
      failsWith("company_data_provider_error", refused),
    );
  });

  it("no token and no input's value in an error, a log line, the console or a metric label", async (t) => {
    const page = "https://www.linkedin.com/company/quillmarsh-tide";
    const domain = "quillmarsh-tide.example";
    const name = "Quillmarsh Tide Holdings";
    const echo = { error: `Quota Exceeded for ${TOKEN} quillmarsh` };
    const answers: (readonly [Answer, CompanyLookup])[] = [
      [FAILURES.company_data_rate_limited, { linkedinUrl: page }],
      [{ status: 429, body: echo }, { domain }],
      [{ status: 401, body: echo }, { name }],
      [
        { status: 500, body: echo },
        { name, countryHint: "GB" },
      ],
      [{ status: 302, headers: { location: `${vendor.origin}/?token=${TOKEN}` } }, { domain }],
      [{ body: `quillmarsh ${TOKEN}` }, { linkedinUrl: page }],
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
    assert.deepEqual(leaked([TOKEN, page, domain, name, "quillmarsh"], seen), []);
  });

  it("from the registry: the free plan's allowance, 400 a month, unless DIFFBOT_ALLOWANCE sets one; not open data; DIFFBOT_TOKEN required at start", async () => {
    const script = [
      "try {",
      `  const { getAdapters } = await import(${JSON.stringify(import.meta.resolve("../../../registry.ts"))});`,
      `  const { companyDataPort } = await import(${JSON.stringify(import.meta.resolve("../../port.ts"))});`,
      "  const [diffbot] = await getAdapters(companyDataPort, ['diffbot']);",
      "  console.log(JSON.stringify([diffbot.allowance, diffbot.openData]));",
      "} catch (error) { console.log(error.code); }",
    ].join("\n");
    const startWith = (env: Record<string, string>) =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, APP_ENV: "test", DIFFBOT_ALLOWANCE: "", ...env },
      }).then(({ stdout }) => stdout.trim());
    const runs: Record<string, string>[] = [
      { DIFFBOT_TOKEN: TOKEN },
      { DIFFBOT_TOKEN: TOKEN, DIFFBOT_ALLOWANCE: "1000/day" },
      { DIFFBOT_TOKEN: TOKEN, DIFFBOT_ALLOWANCE: "lots" },
      { DIFFBOT_TOKEN: "" },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '[{"calls":400,"per":"month"},false]',
      '[{"calls":1000,"per":"day"},false]',
      "config_invalid",
      "config_invalid",
    ]);
  });
});
