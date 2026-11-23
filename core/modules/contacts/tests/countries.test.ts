// The country of a location (README "The place list", gamma-en-075; domain/countries.ts): the text
// cleaned, its parts read from the last, a country's or a division's name or code narrowing where a
// city may lie, a city's name giving the largest place's country unless another country's place of
// that name has more than a tenth of its people; first on a tiny list of the test's, then on the
// committed list for the task's cases and today's. A lead created with such a location has its
// country at once; a source's location the list cannot read keeps the country recorded for the same
// text.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { cleanLocation, countryOf, namesNoPlace } from "../domain/countries.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { recordPersonCountry } from "../domain/person-country.ts";
import { upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt, usePlaces } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
afterEach(() => usePlaces(undefined));
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: "wsp_countries_test", principal }, fn, { client: asRole("app") });

/** A place list's text: `D country code name` and `P name country division population`. */
const list = (...lines: string[]) =>
  [
    "# test list",
    ...lines.map((line) =>
      line
        .split("|")
        .map((field) => field.trim())
        .join("\t"),
    ),
  ].join("\n");
const TINY = list(
  "D | US | ME | Maine | ",
  "D | US | OR | Oregon | ",
  "D | AA | 01 | Twinland | ",
  "D | BB | 01 | Twinland | ",
  "P | Portland | | US | OR | 650000",
  "P | Portland | | US | ME | 68000",
  "P | Portland | | AU | 07 | 10000",
  "P | Harbor | | US | OR | 100000",
  "P | Harbor | | GB | ENG | 10001",
  "P | Quay | | US | OR | 100000",
  "P | Quay | | GB | ENG | 10000",
);

test("the rules on a tiny list: a city's largest place, unless another country's has more than a tenth of its people; a city within the division given; a division's name only when one country has it", () => {
  usePlaces(TINY);
  const cases: [string, string | null][] = [
    ["Portland", "US"],
    ["Portland, Maine", "US"],
    ["Portland, ME", "US"],
    ["Harbor", null],
    ["Quay", "US"],
    ["Harbor, Oregon", "US"],
    ["Twinland", null],
    ["Nowhere Town", null],
    ["Harbor, Germany", "DE"],
  ];
  for (const [location, code] of cases) assert.equal(countryOf(location), code, location);
});

test("the cleaning: 'Greater' before and 'Metropolitan Area', 'Metro Area', 'Bay Area', 'Area' and 'Region' after are dropped, spaces collapsed", () => {
  const cases: [string, string][] = [
    ["Greater Munich Metropolitan Area", "Munich"],
    ["San Francisco Bay Area", "San Francisco"],
    ["Greater Toronto  Area", "Toronto"],
    ["Ruhr Region", "Ruhr"],
    ["Dallas-Fort Worth Metro Area", "Dallas-Fort Worth"],
    ["Greater Paris Metropolitan Region", "Paris"],
    ["Boston, MA", "Boston, MA"],
  ];
  for (const [location, cleaned] of cases) assert.equal(cleanLocation(location), cleaned);
  assert.deepEqual(["Remote", "EMEA, Europe", " ", "Remote, Berlin"].map(namesNoPlace), [
    true,
    true,
    true,
    false,
  ]);
});

test("the committed list: the task's cases, the codes of a US state, a Canadian province and a country, and today's cases still", () => {
  const cases: [string, string | null][] = [
    ["Boston, MA", "US"],
    ["Toronto, ON", "CA"],
    ["Greater Munich Metropolitan Area", "DE"],
    ["San Francisco Bay Area", "US"],
    ["Lyon", "FR"],
    ["Bengaluru, Karnataka, India", "IN"],
    ["Cambridge", null],
    ["Georgia", null],
    ["Atlanta, Georgia", "US"],
    ["Tbilisi, Georgia", "GE"],
    ["Portland, Maine", "US"],
    ["Los Angeles, CA", "US"],
    ["Montreal, CA", "CA"],
    ["Berlin, DE", "DE"],
    ["Indianapolis, IN", "US"],
    ["Remote", null],
    ["Asia", null],
    ["Ruhr Region", null],
    // Today's (tests/domain.test.ts).
    ["London, England, United Kingdom", "GB"],
    ["Berlin, Germany", "DE"],
    ["Istanbul, Türkiye", "TR"],
    ["Abidjan, Cote d'Ivoire", "CI"],
    ["Basseterre, Saint Kitts and Nevis", "KN"],
    ["Hong Kong SAR", "HK"],
    ["United States", "US"],
    ["", null],
  ];
  for (const [location, code] of cases) assert.equal(countryOf(location), code, location);
});

test("a lead created with such a location has its country at once, with the location's provenance, before enrichment runs", async () => {
  const lead = await run(async () => {
    const profile = {
      linkedinUrl: "https://linkedin.com/in/country-at-once",
      firstName: "Noor",
      locationText: "Greater Munich Metropolitan Area",
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: "unipile",
      profile,
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "manual", ref: "usr_a" } });
    return person;
  });
  assert.equal(lead.locationCountry, "DE");
  assert.deepEqual(lead.fieldProvenance.locationCountry, lead.fieldProvenance.locationText);
});

test("a source's location the list cannot read keeps the country recorded for the same text; a new text it cannot read empties it", async () => {
  const linkedinUrl = "https://linkedin.com/in/country-kept";
  const read = (locationText: string, day: number) =>
    run(() =>
      upsertPersonFromSource({
        source: "linkedin",
        provider: "unipile",
        profile: { linkedinUrl, locationText, fetchedAt: new Date(Date.UTC(2026, 10, day)) },
      }),
    );
  const { person } = await read("Ruhr Region", 1);
  assert.equal(person.locationCountry, null);
  const stamp = {
    source: "ai_inferred" as const,
    provider: "country-ai",
    at: new Date(Date.UTC(2026, 10, 2)),
  };
  await run(() => recordPersonCountry({ personId: person.id, country: "DE", stamp }));
  const again = await read("Ruhr  Region", 3);
  assert.equal(again.person.locationCountry, "DE");
  assert.equal(again.person.fieldProvenance.locationCountry?.source, "ai_inferred");
  const moved = await read("Somewhere Else Entirely", 4);
  assert.equal(moved.person.locationCountry, null);
  assert.equal(moved.person.fieldProvenance.locationCountry, undefined);
});
