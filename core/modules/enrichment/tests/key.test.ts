// The lookup's pure rules (domain/lookup/key.ts): the cache key's normalization (case, accents,
// spaces, `www.`), a candidate's domain against the company's, its kind, and the UK and EU rule for a
// personal address, whose list is privacy's 30-day rule's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSENT_COUNTRIES } from "../domain/lookup/constants.ts";
import { atDomain, keyHashOf, kindOf, needsConsent, normalDomain } from "../domain/lookup/key.ts";

test("the key: names lower case, accents folded, spaces collapsed; the domain lower case without www.", () => {
  const key = keyHashOf("José", "García López", "example.com");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(keyHashOf("  JOSE ", "garcia   lopez", "WWW.Example.com."), key);
  assert.notEqual(keyHashOf("Jose", "Garcia", "example.com"), key);
  assert.notEqual(keyHashOf("José", "García López", "example.org"), key);
  assert.deepEqual(["www.Example.COM", " example.com. ", null, undefined].map(normalDomain), [
    "example.com",
    "example.com",
    "",
    "",
  ]);
});

test("a candidate at the company's domain or a subdomain is a work address; any other domain, a look-alike included, a personal one", () => {
  const cases: [string, boolean][] = [
    ["ada@example.com", true],
    ["ada@eu.example.com", true],
    ["ada@EXAMPLE.com", true],
    ["ada@gmail.com", false],
    ["ada@notexample.com", false],
    ["ada@example.com.evil.io", false],
  ];
  for (const [address, at] of cases) {
    assert.equal(atDomain(address, "www.example.com"), at, address);
    assert.equal(kindOf(address, "example.com"), at ? "work_email" : "personal_email", address);
  }
  assert.equal(atDomain("ada@example.com", ""), false);
});

test("a personal address needs consent in the UK, the EU and the EEA, or with no known country, while the switch is off; never once it is on", () => {
  const cases: [string | null, boolean][] = [
    ["GB", true],
    ["FR", true],
    ["NO", true],
    ["RE", true],
    [null, true],
    ["gb", true],
    ["US", false],
    ["CH", false],
    ["IN", false],
  ];
  for (const [country, needed] of cases) {
    assert.equal(needsConsent(country, false), needed, String(country));
    assert.equal(needsConsent(country, true), false, String(country));
  }
});

test("the list is privacy's: the 27 EU members, the EU's regions with codes of their own, the EEA's three and the UK", () => {
  const eu =
    "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" ");
  const expected = [...eu, "AX", "GF", "GP", "MF", "MQ", "RE", "YT", "IS", "LI", "NO", "GB"];
  assert.deepEqual([...CONSENT_COUNTRIES].sort(), expected.sort());
});
