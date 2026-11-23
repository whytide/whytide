// enrichment's sources (README "Sources", "A name that cannot run"; domain/sources/): defineSource
// refusing a definition off the rules, naming the field; company-data's lookup in the port's forms,
// with nothing of the person, and its facts in contacts' words; the lists loaded once, `company-data`
// expanded per adapter in PROVIDER_COMPANY_DATA's order, and every name that cannot run left out with
// its reason and the variables it lacks, one warning per list, never a value. Email sources
// (gamma-en-080): a name unique within its kind, and the email lists loaded as the company's.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { collectLogs, createLogger, isAppError } from "@whytide/platform";
import { loadEmail } from "../domain/lookup/sources.ts";
import { factsOf, lookupOf } from "../domain/sources/company-data.ts";
import { defineSource, type SourceDefinition } from "../domain/sources/define.ts";
import { loadSources, warnLeftOut } from "../domain/sources/index.ts";
import { sourceList } from "../settings.ts";
import { useEmailLists, useSourceLists } from "../testing/index.ts";

afterEach(() => useSourceLists(undefined));
const source = (more: Partial<SourceDefinition>): SourceDefinition => ({
  name: "test-company",
  kind: "company",
  fills: ["industry"],
  needs: ["domain"],
  activityKind: "db",
  provenance: { source: "web_search", provider: "test-company" },
  run: async () => ({ found: false }),
  ...more,
});
const refused = (field: string) => (error: unknown) =>
  isAppError(error) && error.code === "enrichment_source_invalid" && error.details?.field === field;

test("defineSource registers a source by its name and refuses one off the rules, naming the field", () => {
  const person = defineSource(
    source({
      name: "test-person",
      kind: "person",
      fills: ["person.country"],
      needs: ["locationText"],
    }),
  );
  assert.equal(person.name, "test-person");
  assert.ok(Object.isFrozen(person));
  defineSource(source({}));
  for (const name of ["Test", "company-data", "test-company", "a/b"]) {
    assert.throws(() => defineSource(source({ name })), refused("name"), name);
  }
  assert.throws(() => defineSource(source({ name: "x1", fills: [] })), refused("fills"));
  assert.throws(
    () => defineSource(source({ name: "x2", fills: ["person.country"] })),
    refused("fills"),
  );
  const personCompany = { name: "x3", kind: "person", fills: ["industry"] } as const;
  assert.throws(() => defineSource(source(personCompany)), refused("fills"));
  assert.throws(() => defineSource(source({ name: "x4", needs: [] })), refused("needs"));
  const email = ["email"] as unknown as SourceDefinition["needs"];
  assert.throws(() => defineSource(source({ name: "x5", needs: email })), refused("needs"));
  const provenance = { source: "web_search", provider: "Not A Name" } as const;
  assert.throws(() => defineSource(source({ name: "x6", provenance })), refused("provenance"));
});

test("company-data's lookup: the company's keys and country in the port's forms, each off-form one left out, none of the person; no key, no lookup", () => {
  const stored = {
    linkedinUrl: "https://linkedin.com/company/blue-harbor",
    domain: "blueharbor.example",
    name: "Blue Harbor Labs",
    country: "DE",
  };
  assert.deepEqual(lookupOf(stored), {
    linkedinUrl: "https://www.linkedin.com/company/blue-harbor",
    domain: "blueharbor.example",
    name: "Blue Harbor Labs",
    countryHint: "DE",
  });
  const offForm = { linkedinUrl: "https://linkedin.com/in/ada", domain: "WWW.X", name: "Acme" };
  assert.deepEqual(lookupOf(offForm), { name: "Acme" });
  assert.equal(lookupOf({ domain: "not a domain", name: "   ", country: "DE" }), null);
  assert.equal(lookupOf({}), null);
});

test("company-data's facts in contacts' words: a size band as its range's text, the headcount beside it; the name and the founding year dropped", () => {
  const facts = {
    name: "Blue Harbor Labs",
    domain: "blueharbor.example",
    employeeRange: { from: 51, to: 200 },
    employeeCount: 120,
    foundedYear: 1999,
    country: "DE",
  };
  assert.deepEqual(factsOf(facts), {
    domain: "blueharbor.example",
    sizeRange: "51-200",
    employeeCount: 120,
    country: "DE",
  });
  assert.deepEqual(factsOf({ industry: "Software", employeeRange: { from: 10001 } }), {
    industry: "Software",
    sizeRange: "10001+",
  });
});

test("the lists loaded: company-data expanded per adapter in its list's order; a name no source of the list's kind defines, an adapter the registry does not know and one without its key left out, with the reason and the variable, one warning per list and no value", async () => {
  useSourceLists({
    company: ["company-data", "nowhere", "test-person"],
    person: ["company-data"],
    companyData: ["nope", "fake", "companies-house"],
  });
  const loaded = await loadSources();
  assert.equal(await loadSources(), loaded, "loaded once");
  assert.deepEqual(
    loaded.sources.map(({ name }) => name),
    ["company-data/fake"],
  );
  const [fake] = loaded.sources;
  assert.deepEqual(fake?.provenance, { source: "data_vendor", provider: "fake" });
  assert.deepEqual(loaded.leftOut, [
    { list: "PROVIDER_COMPANY_DATA", name: "nope", reason: "provider_unknown", variables: [] },
    {
      list: "PROVIDER_COMPANY_DATA",
      name: "companies-house",
      reason: "config_invalid",
      variables: ["COMPANIES_HOUSE_API_KEY"],
    },
    {
      list: "ENRICHMENT_COMPANY_SOURCES",
      name: "nowhere",
      reason: "source_unknown",
      variables: [],
    },
    {
      list: "ENRICHMENT_COMPANY_SOURCES",
      name: "test-person",
      reason: "source_unknown",
      variables: [],
    },
    {
      list: "ENRICHMENT_PERSON_SOURCES",
      name: "company-data",
      reason: "source_unknown",
      variables: [],
    },
  ]);

  const logs = collectLogs();
  warnLeftOut(createLogger({ destination: logs.destination }), loaded.leftOut);
  const warned = logs.lines().map(({ level, variable, details }) => ({ level, variable, details }));
  assert.deepEqual(warned, [
    {
      level: "warn",
      variable: "PROVIDER_COMPANY_DATA",
      details: [
        { provider: "nope", reason: "provider_unknown" },
        {
          provider: "companies-house",
          reason: "config_invalid",
          variable: "COMPANIES_HOUSE_API_KEY",
        },
      ],
    },
    {
      level: "warn",
      variable: "ENRICHMENT_COMPANY_SOURCES",
      details: [
        { provider: "nowhere", reason: "source_unknown" },
        { provider: "test-person", reason: "source_unknown" },
      ],
    },
    {
      level: "warn",
      variable: "ENRICHMENT_PERSON_SOURCES",
      details: [{ provider: "company-data", reason: "source_unknown" }],
    },
  ]);

  useSourceLists({ company: ["company-data"], person: [], companyData: [] });
  assert.deepEqual(await loadSources(), { sources: [], leftOut: [] });
});

test("a list's setting: names separated by commas, spaces around a name and an empty name ignored; unset or with no name, the default; a name off its form or twice fails the start", () => {
  const list = sourceList(["company-data"]);
  assert.deepEqual(list.parse("linkedin, company-data"), ["linkedin", "company-data"]);
  assert.deepEqual(list.parse(" linkedin ,,company-data, "), ["linkedin", "company-data"]);
  assert.deepEqual(list.parse(undefined), ["company-data"]);
  assert.deepEqual(list.parse(" "), ["company-data"]);
  assert.deepEqual(list.parse(" , "), ["company-data"]);
  for (const value of ["Linkedin", "linkedin,linkedin", "a/b"]) {
    assert.equal(list.safeParse(value).success, false, value);
  }
});

test("an email source (gamma-en-080): a name unique within its kind, so a company source's name may be an email source's too; `email-finder` and a class off its form refused", () => {
  const email = {
    kind: "email",
    activityKind: "db",
    provenance: { source: "lead_reply", provider: "test-reply" },
    run: async () => ({ found: false }) as const,
  } as const;
  const defined = defineSource({ ...email, name: "test-company" });
  assert.equal(defined.kind, "email");
  assert.throws(() => defineSource({ ...email, name: "test-company" }), refused("name"));
  assert.throws(() => defineSource({ ...email, name: "email-finder" }), refused("name"));
  const provenance = { source: "Lead Reply", provider: "test-reply" };
  assert.throws(() => defineSource({ ...email, name: "y1", provenance }), refused("provenance"));
});

test("the email lists: ENRICHMENT_EMAIL_SOURCES in order, `email-finder` expanded per adapter of PROVIDER_EMAIL_FINDER, the verifiers in PROVIDER_EMAIL_VERIFIER's order, every name that cannot run left out with its reason", async () => {
  useEmailLists({
    sources: ["nowhere", "test-company", "email-finder"],
    finders: ["nope", "fake"],
    verifiers: ["fake", "nope"],
  });
  const { sources, verifiers, leftOut } = await loadEmail();
  assert.deepEqual(
    sources.map(({ name, provenance }) => [name, provenance.source, provenance.provider]),
    [
      ["test-company", "lead_reply", "test-reply"],
      ["email-finder/fake", "email_finder", "fake"],
    ],
  );
  assert.deepEqual(
    verifiers.map(({ name }) => name),
    ["email-verifier/fake"],
  );
  assert.deepEqual(
    leftOut.map(({ list, name, reason }) => [list, name, reason]),
    [
      ["ENRICHMENT_EMAIL_SOURCES", "nowhere", "source_unknown"],
      ["PROVIDER_EMAIL_FINDER", "nope", "provider_unknown"],
      ["PROVIDER_EMAIL_VERIFIER", "nope", "provider_unknown"],
    ],
  );
  useEmailLists(undefined);
});
