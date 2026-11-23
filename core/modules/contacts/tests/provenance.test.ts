// Enrichment's provenance (gamma-en-040; docs/concepts.md "Provenance") on the worktree's database,
// in this file's schema, inside tenant runs as its callers make them: the source classes open_data,
// data_vendor, web_search and ai_inferred beside linkedin, import and website; any adapter's name as
// the provider, as providers' ADAPTER_NAME takes it, unipile and csv still; a member's value still
// outranking every source's; and recordPersonCountry, a source's country by icp's COUNTRIES. The
// copies contacts keeps of providers' pattern and icp's list are read against their files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { upsertCompany } from "../domain/companies.ts";
import { COUNTRIES } from "../domain/constants.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { recordPersonCountry } from "../domain/person-country.ts";
import { editLeadPerson } from "../domain/person-edit.ts";
import { getPerson, upsertPersonFromSource } from "../domain/persons.ts";
import { PROVIDER_NAME, SOURCES } from "../domain/provenance.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WS = "wsp_provenance_test";
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>, workspaceId = WS) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const fails = (code: string, fields?: string[]) => (error: unknown) =>
  isAppError(error) &&
  error.code === code &&
  (fields === undefined || JSON.stringify(error.details?.fields) === JSON.stringify(fields));
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8));
const stampOf = (source: string, provider: string | null, day: number) => ({
  source,
  provider,
  at: at(day).toISOString(),
});

/** A person and their lead, as a LinkedIn source writes them on `day`. */
async function personWithLead(slug: string, locationText = "Berlin, Germany", day = 2) {
  const profile = {
    linkedinUrl: `https://linkedin.com/in/${slug}`,
    firstName: "Ada",
    title: "Head of Data",
    locationText,
    fetchedAt: at(day),
  };
  return run(async () => {
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: "unipile",
      profile,
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
}

test("the source classes are LinkedIn's, an import's and the website's, then enrichment's: open_data, data_vendor, web_search, ai_inferred", () => {
  assert.deepEqual(SOURCES, [
    "linkedin",
    "import",
    "website",
    "open_data",
    "data_vendor",
    "web_search",
    "ai_inferred",
  ]);
});

test("contacts' provider name is providers' ADAPTER_NAME, and its COUNTRIES icp's, each read from its file", () => {
  const config = new URL("../../../packages/providers/_pattern/config.ts", import.meta.url);
  const pattern = /export const ADAPTER_NAME = \/(.+)\/;/.exec(readFileSync(config, "utf8"))?.[1];
  assert.equal(PROVIDER_NAME.source, pattern);
  const lists = readFileSync(new URL("../../icp/domain/lists.ts", import.meta.url), "utf8");
  const block = /export const COUNTRIES[^(]*\(([^)]*)\)/.exec(lists)?.[1] ?? "";
  const icp = [...block.matchAll(/"([^"]*)"/g)]
    .map(([, part]) => part)
    .join("")
    .split(" ");
  assert.equal(icp.length, 249);
  assert.deepEqual(COUNTRIES, icp);
});

test("a field written by the class open_data through wikidata keeps that provenance, on a person and on a company; a member's value of the same field stays", async () => {
  const personId = await personWithLead("ada-open-data");
  await run(() => editLeadPerson(personId, { title: "Chief Data Officer" }));
  const profile = {
    linkedinUrl: "https://linkedin.com/in/ada-open-data",
    headline: "Builds data teams",
    title: "Data Engineer",
    fetchedAt: at(9),
  };
  const { person } = await run(() =>
    upsertPersonFromSource({ source: "open_data", provider: "wikidata", profile }),
  );
  assert.equal(person.headline, "Builds data teams");
  assert.deepEqual(person.fieldProvenance.headline, stampOf("open_data", "wikidata", 9));
  assert.equal(person.title, "Chief Data Officer", "the member's value stays");
  assert.equal(person.fieldProvenance.title?.source, "member");

  const company = { name: "Blue Harbor Labs", domain: "blueharbor.example", fetchedAt: at(9) };
  const written = await run(() =>
    upsertCompany({
      source: "data_vendor",
      provider: "people-data-labs",
      company: { ...company, industry: "Software" },
    }),
  );
  assert.deepEqual(
    written.company.fieldProvenance.industry,
    stampOf("data_vendor", "people-data-labs", 9),
  );
  const later = { ...company, industry: "Computer Software", fetchedAt: at(10) };
  const open = await run(() =>
    upsertCompany({ source: "open_data", provider: "wikidata", company: later }),
  );
  assert.equal(open.company.industry, "Computer Software");
  assert.deepEqual(open.company.fieldProvenance.industry, stampOf("open_data", "wikidata", 10));
});

test("any adapter's name is a provider, unipile and csv still; a name off ADAPTER_NAME or over 64 characters, or a class off the list, is contacts_input_invalid naming it, and nothing is written", async () => {
  const linkedinUrl = "https://linkedin.com/in/ada-providers";
  let personId = "";
  for (const provider of ["unipile", "csv", "wikidata", "companies-house", "google-kg"]) {
    const profile = { linkedinUrl, title: provider };
    const { person } = await run(() =>
      upsertPersonFromSource({ source: "web_search", provider, profile }),
    );
    assert.equal(person.fieldProvenance.title?.provider, provider);
    personId = person.id;
  }
  for (const provider of ["Wikidata", "wiki data", "1pass", "-x", "a".repeat(65), ""]) {
    const profile = { linkedinUrl, title: "Refused" };
    await assert.rejects(
      run(() => upsertPersonFromSource({ source: "ai_inferred", provider, profile })),
      fails("contacts_input_invalid", ["provider"]),
      provider,
    );
  }
  const member = { source: "member", provider: null, profile: { linkedinUrl, title: "Refused" } };
  await assert.rejects(
    run(() => upsertPersonFromSource(member as never)),
    fails("contacts_input_invalid", ["source"]),
  );
  const company = { name: "Kestrel", domain: "kestrel.example" };
  await assert.rejects(
    run(() => upsertCompany({ source: "open_data", provider: "Wikidata", company })),
    fails("contacts_input_invalid", ["provider"]),
  );
  assert.equal((await run(() => getPerson(personId))).title, "google-kg");
});

test("recordPersonCountry writes a listed code with the source's stamp and answers written; a code off COUNTRIES is contacts_input_invalid naming country, and nothing is written", async () => {
  const personId = await personWithLead("ada-country", "Dallas-Fort Worth Metroplex");
  assert.equal((await run(() => getPerson(personId))).locationCountry, null);
  const stamp = { source: "ai_inferred", provider: "country-ai", at: at(5) } as const;
  for (const country of ["XK", "pt", "Portugal", "ZZ", "UK", "EU", ""]) {
    await assert.rejects(
      run(() => recordPersonCountry({ personId, country, stamp })),
      fails("contacts_input_invalid", ["country"]),
      country,
    );
  }
  assert.equal((await run(() => getPerson(personId))).locationCountry, null);
  const { person, written } = await run(() =>
    recordPersonCountry({ personId, country: "US", stamp }),
  );
  assert.equal(written, true);
  assert.equal(person.locationCountry, "US");
  assert.deepEqual(person.fieldProvenance.locationCountry, stampOf("ai_inferred", "country-ai", 5));
  assert.equal(person.locationText, "Dallas-Fort Worth Metroplex", "the location stays");
  assert.deepEqual(person.fieldProvenance.locationText, stampOf("linkedin", "unipile", 2));
});

test("recordPersonCountry keeps a member's country and one read later than its own; a stamp off the rules is contacts_input_invalid; another workspace's person is person_not_found", async () => {
  const edited = await personWithLead("ada-member-country");
  await run(() => editLeadPerson(edited, { locationText: "Lisbon, Portugal" }));
  const late = { source: "open_data", provider: "wikidata", at: at(30) } as const;
  const kept = await run(() =>
    recordPersonCountry({ personId: edited, country: "ES", stamp: late }),
  );
  assert.equal(kept.written, false);
  assert.equal(kept.person.locationCountry, "PT");
  assert.equal(kept.person.fieldProvenance.locationCountry?.source, "member");

  // The LinkedIn location, Germany, was read on day 2: an older country loses, a newer one wins.
  const read = await personWithLead("ada-older-country");
  const early = { source: "data_vendor", provider: "pdl", at: at(1) } as const;
  const older = await run(() =>
    recordPersonCountry({ personId: read, country: "FR", stamp: early }),
  );
  assert.deepEqual([older.written, older.person.locationCountry], [false, "DE"]);
  const newer = await run(() =>
    recordPersonCountry({ personId: read, country: "AT", stamp: { ...early, at: at(3) } }),
  );
  assert.deepEqual([newer.written, newer.person.locationCountry], [true, "AT"]);

  const refused = [
    [{ source: "member", provider: null }, "stamp.source"],
    [{ source: "open_data", provider: "Wikidata" }, "stamp.provider"],
  ] as const;
  for (const [stamp, field] of refused) {
    await assert.rejects(
      run(() => recordPersonCountry({ personId: read, country: "AT", stamp: stamp as never })),
      fails("contacts_input_invalid", [field]),
    );
  }
  await assert.rejects(
    run(() => recordPersonCountry({ personId: read, country: "AT", stamp: early }), "wsp_other"),
    fails("person_not_found"),
  );
});
