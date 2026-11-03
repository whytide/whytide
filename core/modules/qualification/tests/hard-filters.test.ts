// The hard filters of alpha-p6-010 (docs/concepts.md), one test per criterion: the fifty title pairs
// of fixtures/titles.json; the country and size rules with the balanced rule for unknowns, and the
// size parser over fixtures/sizes.json; purity, and the speed of the filters prepared for a
// fifty-title ICP; the compared values in the detail; and contacts' and icp's records taken as they
// are. Pure: no database.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import type { Person, WorkspaceCompany } from "@whytide/contacts";
import type { Icp } from "@whytide/icp";
import {
  applyHardFilters,
  type HardFilterCompany,
  type HardFilterIcp,
  type HardFilterPerson,
  prepareHardFilters,
} from "../domain/hard-filters/index.ts";
import { sizeRangesOf } from "../domain/hard-filters/size.ts";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as T;
const open: HardFilterIcp = { titles: [], countries: [], sizeRanges: [] };

/** The value, frozen through: a write anywhere in it throws (ES modules are strict). */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") Object.values(value).forEach(frozen);
  return Object.freeze(value);
}

test("titles: each of the fifty pairs of fixtures/titles.json yields its outcome", () => {
  type Groups = { groups: { rule: string; pairs: [string, string, boolean][] }[] };
  const pairs = fixture<Groups>("titles.json").groups.flatMap((group) => group.pairs);
  assert.equal(pairs.length, 50);
  for (const [title, icpTitle, passes] of pairs) {
    const result = applyHardFilters({ title }, null, { ...open, titles: [icpTitle] });
    assert.equal(result.passed, passes, `${title} / ${icpTitle}`);
  }
});

test("countries and sizes: a known mismatch fails; no value, or an ICP list left empty, passes", () => {
  const icp: HardFilterIcp = { ...open, countries: ["DE", "AT", "CH"], sizeRanges: ["201-500"] };
  const outcome = (person: HardFilterPerson, company: HardFilterCompany | null, of = icp) => {
    const result = applyHardFilters(person, company, of);
    return result.passed ? "passed" : result.reason;
  };
  assert.equal(outcome({ locationCountry: "FR" }, null), "country_mismatch");
  assert.equal(outcome({ locationCountry: "ch" }, null), "passed");
  assert.equal(outcome({ locationCountry: null }, null), "passed");
  assert.equal(outcome({ locationCountry: "FR" }, null, { ...icp, countries: [] }), "passed");
  assert.equal(outcome({}, { sizeRange: "11 to 50" }), "size_mismatch");
  assert.equal(outcome({}, { sizeRange: "201-500 employees" }), "passed");
  assert.equal(outcome({}, { sizeRange: "about forty" }), "passed");
  assert.equal(outcome({}, null), "passed", "no company row: the size is unknown");
  assert.equal(outcome({}, { sizeRange: "11 to 50" }, { ...icp, sizeRanges: [] }), "passed");
  type Sizes = { sizes: [string, string[] | null][] };
  for (const [text, ranges] of fixture<Sizes>("sizes.json").sizes) {
    assert.deepEqual(sizeRangesOf(text), ranges, text);
  }
});

test("pure: no import outside domain/, frozen inputs, the same answer twice; 1,000 runs under 50 ms, prepared for fifty titles", () => {
  const folder = new URL("../domain/hard-filters/", import.meta.url);
  for (const file of readdirSync(folder)) {
    const source = readFileSync(new URL(file, folder), "utf8");
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']*)["']/g)) {
      assert.match(specifier ?? "", /^\.\/[\w-]+\.ts$/, `${file} imports ${specifier}`);
    }
  }
  // Fifty titles, icp's limit (its LIMITS.titles), most of them missed by most persons.
  const areas = ["Sales", "Marketing", "Revenue Operations", "Business Development", "Growth"];
  const more = ["Customer Success", "Partnerships", "Demand Generation", "Product Marketing", "IT"];
  const icp = frozen<HardFilterIcp>({
    titles: [...areas, ...more].flatMap((area) => [
      `Head of ${area}`,
      `VP ${area}`,
      `Director of ${area}`,
      `${area} Manager`,
      `${area} Lead`,
    ]),
    countries: ["DE", "AT", "CH"],
    sizeRanges: ["51-200", "201-500"],
  });
  assert.equal(icp.titles.length, 50);
  const titles = ["VP of Sales", "Account Executive", "Co-Founder & CEO", "Sr. SDR", null];
  const countries = ["DE", "FR", "CH", null];
  const sizes = ["51-200 employees", "10,001+", "11 to 50", null];
  const inputs = Array.from({ length: 1000 }, (_, at) =>
    frozen({
      person: { title: titles[at % 5], locationCountry: countries[at % 4] },
      company: at % 7 === 0 ? null : { sizeRange: sizes[at % 4] },
    }),
  );
  const filters = prepareHardFilters(icp);
  const run = () => inputs.map(({ person, company }) => filters(person, company));
  const first = run();
  assert.deepEqual(run(), first);
  const unprepared = inputs.map(({ person, company }) => applyHardFilters(person, company, icp));
  assert.deepEqual(unprepared, first);
  const timings = [1, 2, 3].map(() => {
    const start = performance.now();
    run();
    return performance.now() - start;
  });
  const best = Math.min(...timings);
  assert.ok(best < 50, `a thousand evaluations took ${best.toFixed(1)} ms at best of three`);
});

test("detail: the reason with the compared values, for the lead page; title, country, size in order", () => {
  const icp: HardFilterIcp = {
    titles: ["Head of Sales"],
    countries: ["DE", "AT", "CH"],
    sizeRanges: ["201-500"],
  };
  const sdr = { title: " Sales Development Representative ", locationCountry: "FR" };
  assert.deepEqual(applyHardFilters(sdr, { sizeRange: "11 to 50" }, icp), {
    passed: false,
    reason: "title_mismatch",
    detail: { value: "Sales Development Representative", icp: ["Head of Sales"] },
  });
  const head = { title: "Director of Sales", locationCountry: "fr" };
  assert.deepEqual(applyHardFilters(head, { sizeRange: "11 to 50" }, icp), {
    passed: false,
    reason: "country_mismatch",
    detail: { value: "FR", icp: ["DE", "AT", "CH"] },
  });
  const inDach = { ...head, locationCountry: "DE" };
  assert.deepEqual(applyHardFilters(inDach, { sizeRange: " 11 to 50" }, icp), {
    passed: false,
    reason: "size_mismatch",
    detail: { value: "11 to 50", icp: ["201-500"] },
  });
});

test("inputs: contacts' Person and WorkspaceCompany and icp's Icp go in as they are", () => {
  const at = new Date("2026-10-22T08:00:00.000Z");
  const person: Person = {
    id: "per_01",
    workspaceId: "ws_01",
    linkedinUrl: "https://linkedin.com/in/example-person",
    providerRefs: null,
    firstName: null,
    lastName: null,
    headline: null,
    title: "Vice President of Sales",
    companyName: "Example Industries",
    companyId: "wco_01",
    locationText: "Vienna, Austria",
    locationCountry: "AT",
    fieldProvenance: {},
    createdAt: at,
    updatedAt: at,
  };
  const company: WorkspaceCompany = {
    id: "wco_01",
    workspaceId: "ws_01",
    name: "Example Industries",
    domain: "example.com",
    linkedinUrl: null,
    industry: null,
    sizeRange: "51-200 employees",
    country: "AT",
    providerRefs: null,
    fieldProvenance: {},
    createdAt: at,
    updatedAt: at,
  };
  const icp: Icp = {
    id: "icp_01",
    name: "DACH mid-market",
    titles: ["VP Sales"],
    seniorities: ["vp"],
    industries: [],
    sizeRanges: ["51-200"],
    countries: ["DE", "AT", "CH"],
    mustHaves: "",
    disqualifiers: "",
    version: 1,
    updatedAt: at,
  };
  assert.deepEqual(applyHardFilters(person, company, icp), { passed: true });
  assert.equal(applyHardFilters(person, company, { ...icp, sizeRanges: ["5001+"] }).passed, false);
});
