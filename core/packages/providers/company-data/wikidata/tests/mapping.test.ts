// The wikidata adapter offline (../README.md "Tests"), on Wikidata's answers served on 127.0.0.1
// (world.ts), never the real service: the port's contract suite; every row of the README's mapping
// table from one item, the requests made read back; none, two and an item with no fact; the order of
// the keys; two lookups a second apart through the process's gate; the pattern's redirect, bound and
// timeout; no input or contact leaked; the adapter as a host starts it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it, test } from "node:test";
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
import type { Gate } from "../client.ts";
import { MAX_ANSWER_BYTES, MIN_INTERVAL_MS, PRODUCT, SEARCH, TIMEOUT_MS } from "../constants.ts";
import { wikidataCompanyData } from "../index.ts";
import { DOMAIN, FACTS, NAME, PAGE, queryOf, route, templateOf, valuesOf } from "./world.ts";

const CONTACT = "ops@whytide.example";
const vendor = await startVendor(route);
after(() => vendor.close());
/** No wait between requests, but for the test of the process's gate. */
const direct: Gate = (request) => request();
const options = {
  contact: CONTACT,
  sparqlUrl: `${vendor.origin}/sparql`,
  apiUrl: `${vendor.origin}/w/api.php`,
};
/** The adapter on the local Wikidata, on `gate`, else on the process's gate. */
const adapter = (gate?: Gate) =>
  bindPort(companyDataPort, wikidataCompanyData({ ...options, ...(gate ? { gate } : {}) }), {
    adapter: "wikidata",
  });
const wikidata = adapter(direct);
const since = () => vendor.requests.length;
const found = { result: "found", company: FACTS };
const notFound = { result: "not_found" };

const offline = { port: companyDataPort, name: "wikidata", requires: [] } as const;
contractSuite(
  companyDataPort,
  { ...offline, create: () => wikidataCompanyData({ ...options, gate: direct }) },
  companyDataCases(
    vendorWorld(
      vendor,
      { lookup: { linkedinUrl: PAGE }, facts: FACTS },
      { domain: "unknown-harbor.example" },
    ),
  ),
);

describe("the wikidata adapter on Wikidata's answers", () => {
  it("maps every row of the README's table from one item, by each key; its requests carry the key and the User-Agent with WIKIDATA_CONTACT, nothing else", async () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    assert.deepEqual(mappedFields(readme).toSorted(), Object.keys(FACTS).toSorted());
    const first = since();
    const page = PAGE.replace("copper-harbor-labs", "Copper-Harbor-Labs");
    assert.deepEqual(await wikidata.lookupCompany({ linkedinUrl: page }), found);
    assert.deepEqual(await wikidata.lookupCompany({ domain: DOMAIN, countryHint: "GB" }), found);
    assert.deepEqual(await wikidata.lookupCompany({ name: NAME, countryHint: "GB" }), found);
    const [byPage, byWebsite, search, byName, ...more] = vendor.requests.slice(first);
    assert.equal(more.length, 0, "one request a key, two for the name");
    for (const request of [byPage, byWebsite, search, byName]) {
      assert.equal(request?.headers["user-agent"], `${PRODUCT} (${CONTACT})`);
      assert.ok(!request?.url.includes(CONTACT), "the contact in no URL");
    }
    const sites = ["http://", "https://"].flatMap((scheme) =>
      ["", "www."].flatMap((www) => ["", "/"].map((end) => `<${scheme}${www}${DOMAIN}${end}>`)),
    );
    const queries = [
      [byPage, { id: ['"Copper-Harbor-Labs"', '"copper-harbor-labs"'] }],
      [byWebsite, { site: sites }],
      [byName, { item: ["wd:Q1001", "wd:Q1003"], country: ['"GB"'] }],
    ] as const;
    for (const [request, values] of queries) {
      assert.equal(request?.method, "POST");
      assert.equal(request?.path, "/sparql");
      assert.equal(request?.headers["content-type"], "application/x-www-form-urlencoded");
      assert.deepEqual([...new URLSearchParams(request?.body).keys()], ["query"]);
      const query = queryOf(request ?? assert.fail());
      assert.deepEqual(valuesOf(query), values);
      assert.deepEqual(leaked([NAME, DOMAIN, "copper-harbor-labs", '"GB"'], templateOf(query)), []);
    }
    assert.deepEqual([search?.method, search?.path, search?.body], ["GET", "/w/api.php", ""]);
    assert.deepEqual(search?.query, { ...SEARCH, search: NAME });
  });

  it("none, two items and an item with no fact are not_found; a key that finds none hands on to the next, one that finds two stops", async () => {
    const lookups = [
      [{ linkedinUrl: `${PAGE}-unknown`, domain: DOMAIN }, found, 2],
      [
        { linkedinUrl: "https://www.linkedin.com/company/twin-harbor", domain: DOMAIN },
        notFound,
        1,
      ],
      [{ linkedinUrl: "https://www.linkedin.com/company/bare-harbor" }, notFound, 1],
      [{ domain: "unknown-harbor.example", name: "Unknown Harbor" }, notFound, 2],
      [{ name: "Copper Harbor" }, notFound, 1],
    ] as const;
    for (const [lookup, answer, requests] of lookups) {
      const first = since();
      assert.deepEqual(await wikidata.lookupCompany(lookup), answer, JSON.stringify(lookup));
      assert.equal(since() - first, requests, JSON.stringify(lookup));
    }
  });

  it("two lookups in a row start at least a second apart, through the process's gate", async (t) => {
    const fetch = globalThis.fetch;
    const starts: number[] = [];
    t.mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => {
      starts.push(Date.now());
      return fetch(...args);
    });
    const gated = adapter();
    const lookup = { linkedinUrl: PAGE };
    assert.deepEqual(
      await Promise.all([gated.lookupCompany(lookup), gated.lookupCompany(lookup)]),
      [found, found],
    );
    assert.equal(starts.length, 2);
    assert.ok(
      (starts[1] ?? 0) - (starts[0] ?? 0) >= MIN_INTERVAL_MS,
      `${starts[1]} - ${starts[0]}`,
    );
    assert.equal(MIN_INTERVAL_MS, 1_000);
  });

  it("a redirect is never followed, an answer past 1 MiB never read whole, no answer within 10 s given up: company_data_provider_error", async (t) => {
    const lookup = () => wikidata.lookupCompany({ linkedinUrl: PAGE });
    await checkPattern(t, vendor, lookup, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [1_048_576, 10_000]);
  });

  it("no input's value and no contact in an error or a log line", async () => {
    const lookups = [{ linkedinUrl: PAGE }, { domain: DOMAIN }, { name: NAME, countryHint: "GB" }];
    const seen = await failuresSeen(wikidata, vendor, lookups, Object.values(FAILURES));
    assert.deepEqual(leaked([NAME, DOMAIN, "copper-harbor-labs", CONTACT], seen), []);
  });
});

test("the adapter as a host starts it: open data, no allowance unless set, WIKIDATA_CONTACT required", async () => {
  const module = import.meta.resolve("../index.ts");
  const empty = { WIKIDATA_CONTACT: "", WIKIDATA_ALLOWANCE: "" };
  assert.deepEqual(await startedIn(module, "wikidataAdapter", empty), {
    openData: true,
    allowance: null,
    created: "config_invalid",
  });
  const set = { WIKIDATA_CONTACT: CONTACT, WIKIDATA_ALLOWANCE: "5000/day" };
  assert.deepEqual(await startedIn(module, "wikidataAdapter", set), {
    openData: true,
    allowance: { calls: 5000, per: "day" },
    created: "created",
  });
});
