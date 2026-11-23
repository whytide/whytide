// The plan as unit tests (README "How it works", docs/flows.md "The pass"): the fields a run wants,
// a member's left alone, an old fact wanted again (gamma-rf-020); the inputs it starts with; why it skips the company; and the pass, walked as
// the workflow walks it (workflows/workflows.ts), in order, each source once, restarted from the top
// when a source adds a domain or a LinkedIn page. The end-to-end pass is the worker's
// tests/enrichment-run.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPANY_FIELDS, DAY_MS, type Field, type Input } from "../domain/constants.ts";
import {
  type CompanyRun,
  companySkip,
  companyWanted,
  inputsAdded,
  inputsOf,
  nextSource,
  oldFact,
  type Plan,
  type PlanEntry,
  personWanted,
  type SourceTried,
  triedCompany,
  triedOf,
} from "../domain/plan.ts";

const AT = "2026-11-13T10:00:00.000Z";
const member = { source: "member", provider: null, at: AT };
const vendor = { source: "data_vendor", provider: "pdl", at: AT };
const company = {
  domain: "blueharbor.example",
  linkedinUrl: null,
  industry: "",
  sizeRange: "51-200",
  country: null,
  description: null,
  fieldProvenance: {},
};
const person = { locationCountry: null, fieldProvenance: {} };
/** The run starts at AT; a fact is old past ENRICHMENT_FACT_DAYS' default. */
const age = { at: new Date(AT), days: 180 };
const ago = (days: number) => new Date(Date.parse(AT) - days * DAY_MS).toISOString();
const entry = (source: string, needs: Input[], fills: Field[]): PlanEntry => ({
  source,
  activityKind: "provider",
  needs,
  fills,
  timeoutSeconds: 15,
});
const tried = (outcome: SourceTried["outcome"]): SourceTried => ({
  source: "company-data/fake",
  outcome,
  code: outcome === "failed" ? "company_data_unauthorized" : null,
  filled: [],
  ms: 3,
});
const ALL: CompanyRun = { wanted: [...COMPANY_FIELDS], tried: [tried("found")] };
const skip = { company: true, companyName: true, trigger: "new_lead", running: false } as const;

/**
 * The workflow's pass over `plan`: the sources in the order asked, each answering the fields it
 * fills from `answers`, which leave the open fields and add their inputs.
 */
function walk(plan: Plan, answers: Readonly<Record<string, readonly Field[]>>): string[] {
  const asked = new Set<string>();
  const have = new Set<Input>(plan.have);
  const open = new Set<Field>(plan.wanted);
  for (;;) {
    const next = nextSource(plan, asked, have, open);
    if (next === undefined) return [...asked];
    asked.add(next.source);
    const filled = answers[next.source] ?? [];
    for (const field of filled) open.delete(field);
    for (const input of inputsAdded(filled)) have.add(input);
  }
}

test("the wanted fields: the company's empty ones, every one with no company yet; a value or an empty field a member set is never wanted; the person's country only while empty and a person source fills it", () => {
  assert.deepEqual(companyWanted(null, age), [...COMPANY_FIELDS]);
  assert.deepEqual(companyWanted(company, age), [
    "linkedinUrl",
    "industry",
    "country",
    "description",
  ]);
  const stamped = {
    ...company,
    industry: "Software",
    fieldProvenance: { industry: member, country: member, linkedinUrl: vendor },
  };
  assert.deepEqual(companyWanted(stamped, age), ["linkedinUrl", "description"]);

  assert.deepEqual(personWanted(person, ["person.country"]), ["person.country"]);
  assert.deepEqual(personWanted(person, []), []);
  assert.deepEqual(personWanted({ ...person, locationCountry: "DE" }, ["person.country"]), []);
  const cleared = { locationCountry: null, fieldProvenance: { locationCountry: member } };
  assert.deepEqual(personWanted(cleared, ["person.country"]), []);
});

test("an old fact: a source's industry, size, country or description stamped more than the days before the run starts is wanted again, 181 days ago but not 179 nor 180, whatever its source; never a member's value, whatever its age, nor a key with a value; with the days at 0, no fact with a value (gamma-rf-020)", () => {
  const source = (days: number) => ({ ...vendor, at: ago(days) });
  const known = {
    domain: "blueharbor.example",
    linkedinUrl: "https://linkedin.com/company/blue-harbor",
    industry: "Software",
    sizeRange: "51-200",
    country: "GB",
    description: "Charts for harbours.",
    fieldProvenance: {
      domain: source(400),
      linkedinUrl: source(400),
      industry: { source: "open_data", provider: "wikidata", at: ago(181) },
      sizeRange: source(179),
      country: { ...member, at: ago(400) },
      description: source(181),
    },
  };
  assert.deepEqual(companyWanted(known, age), ["industry", "description"]);
  assert.equal(oldFact(known, "industry", age), true);
  assert.equal(oldFact(known, "sizeRange", age), false);
  assert.equal(
    oldFact({ ...known, fieldProvenance: { industry: source(180) } }, "industry", age),
    false,
  );
  // A member's value, however old; a key with a value, however old; a value with no stamp.
  assert.equal(oldFact(known, "country", age), false);
  assert.equal(oldFact(known, "domain", age), false);
  assert.equal(oldFact(known, "linkedinUrl", age), false);
  assert.equal(oldFact({ ...known, fieldProvenance: {} }, "industry", age), false);
  // The days at 0: no fact with a value is wanted; an empty one still is.
  const never = { ...age, days: 0 };
  assert.deepEqual(companyWanted(known, never), []);
  assert.deepEqual(companyWanted({ ...known, description: null }, never), ["description"]);
});

test("the inputs a run starts with: the company's page and domain when set, its name, the person's location text", () => {
  const located = { companyName: "Blue Harbor Labs", locationText: "Berlin, Germany" };
  assert.deepEqual(inputsOf(company, located, true), ["domain", "name", "locationText"]);
  const page = { linkedinUrl: "https://linkedin.com/company/blue-harbor", domain: "" };
  assert.deepEqual(inputsOf(page, { companyName: null, locationText: "" }, false), ["linkedinUrl"]);
  assert.deepEqual(inputsOf(null, { companyName: "Blue Harbor Labs", locationText: null }, true), [
    "name",
  ]);
});

test("why a run skips its company: no company and no name; a new lead's company that a run tried within the retry days for every field wanted now, which a request asks again; another run working on it", () => {
  const wanted = ["industry", "country"] as const;
  assert.equal(
    companySkip({ ...skip, company: false, companyName: false, wanted, recent: [] }),
    "no_company",
  );
  assert.equal(companySkip({ ...skip, company: false, wanted, recent: [] }), null);
  assert.equal(companySkip({ ...skip, wanted, recent: [ALL] }), "enriched_recently");
  assert.equal(companySkip({ ...skip, trigger: "request", wanted, recent: [ALL] }), null);
  // A source that answered not_found or no_company_key tried the company too, and so did
  // web-search's not_a_company and ambiguous (gamma-en-070).
  for (const outcome of ["not_found", "no_company_key", "not_a_company", "ambiguous"] as const) {
    const recent = [{ ...ALL, tried: [tried("failed"), tried(outcome)] }];
    assert.equal(companySkip({ ...skip, wanted, recent }), "enriched_recently", outcome);
  }
  // A run where every source failed, was out of calls or skipped in its own word (`no_account`, not
  // in ANSWERED) tried nothing: the next new lead asks again.
  const failed = {
    ...ALL,
    tried: [tried("failed"), tried("allowance_spent"), tried("no_account")],
  };
  assert.equal(triedCompany(failed), false);
  assert.equal(companySkip({ ...skip, wanted, recent: [failed] }), null);
  // A run that wanted fewer fields than the company lacks now did not try those.
  const fewer = { ...ALL, wanted: ["industry"] };
  assert.equal(companySkip({ ...skip, wanted, recent: [fewer] }), null);
  assert.equal(companySkip({ ...skip, wanted, recent: [fewer, ALL] }), "enriched_recently");

  assert.equal(companySkip({ ...skip, wanted, recent: [], running: true }), "company_running");
  assert.equal(
    companySkip({ ...skip, trigger: "request", wanted, recent: [], running: true }),
    "company_running",
  );
});

test("the pass: in the plan's order, each source once; one with none of its inputs waits, one with no open field to fill is passed; a source that adds a domain restarts it from the top, and the earlier source that needed the domain runs then, once", () => {
  const plan: Plan = {
    sources: [
      entry("by-domain", ["domain"], ["industry", "country"]),
      entry("by-name", ["name"], ["domain", "sizeRange"]),
      entry("size-only", ["name"], ["sizeRange"]),
      entry("last", ["name", "domain"], ["industry", "description"]),
    ],
    wanted: ["domain", "industry", "sizeRange", "country", "description"],
    have: ["name"],
  };
  const answers = { "by-name": ["domain", "sizeRange"], "by-domain": ["industry"] } as const;
  assert.deepEqual(walk(plan, answers), ["by-name", "by-domain", "last"]);
  // Without the domain, the source that needs it never runs; every other one runs once.
  assert.deepEqual(walk(plan, { "by-name": ["sizeRange"] }), ["by-name", "last"]);
  // Nothing open: nothing asked.
  assert.deepEqual(walk({ ...plan, wanted: [] }, {}), []);
  assert.deepEqual(inputsAdded(["linkedinUrl", "industry", "domain"]), ["linkedinUrl", "domain"]);
});

test("sources_tried as stored: an array is the entries, anything else none", () => {
  assert.deepEqual(triedOf([tried("found")]), [tried("found")]);
  assert.deepEqual(triedOf(null), []);
  assert.deepEqual(triedOf({ source: "x" }), []);
});
