// The 30-day rule as a table, pure (README.md "The 30-day rule"; gamma-p7-010): the cutoff, the day
// before and the day after it, each country case, touched and untouched; and the rule's constants.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cutoffOf, type FoundPerson, isCandidate } from "../domain/retention/candidates.ts";
import {
  RETENTION_AT_UTC,
  RETENTION_EU_UK_COUNTRIES,
  RETENTION_MAX_PER_RUN,
  RETENTION_NEVER_CONTACTED_DAYS,
  RETENTION_OPERATOR,
  RETENTION_SWEEP_DELAY_MINUTES,
} from "../domain/retention/constants.ts";

const RUN = new Date("2026-11-01T03:15:00.000Z");
const CUTOFF = cutoffOf(RUN);
const daysBefore = (days: number) => new Date(RUN.getTime() - days * 86_400_000);
const person = (
  country: string | null,
  foundDaysBefore: number,
  touched: Date | null = null,
): FoundPerson => ({
  createdAt: daysBefore(foundDaysBefore),
  lastTouchAt: touched,
  locationCountry: country,
});

test("the cutoff is the run's instant less 30 days", () => {
  assert.deepEqual(CUTOFF, new Date("2026-10-02T03:15:00.000Z"));
  assert.equal(RETENTION_NEVER_CONTACTED_DAYS, 30);
});

test("the candidate rule: never touched, found at or before the cutoff, in the EU, the EEA, the UK or nowhere known", () => {
  const cases: [string, FoundPerson, boolean][] = [
    ["GB, found 31 days before", person("GB", 31), true],
    ["FR, found 31 days before", person("FR", 31), true],
    ["no country, found 31 days before", person(null, 31), true],
    ["GB, found at the cutoff", { ...person("GB", 0), createdAt: CUTOFF }, true],
    [
      "GB, found a millisecond after the cutoff",
      { ...person("GB", 0), createdAt: new Date(CUTOFF.getTime() + 1) },
      false,
    ],
    ["GB, found the day after the cutoff (29 days before)", person("GB", 29), false],
    ["US, found 60 days before", person("US", 60), false],
    ["CH, found 60 days before: not on the list", person("CH", 60), false],
    ["GB, found 60 days before, invited", person("GB", 60, daysBefore(40)), false],
    ["no country, found 60 days before, emailed yesterday", person(null, 60, daysBefore(1)), false],
    ["NO, the EEA", person("NO", 31), true],
    ["IS, the EEA", person("IS", 31), true],
    ["LI, the EEA", person("LI", 31), true],
    ["RE, an EU region with a code of its own", person("RE", 31), true],
    ["AX, an EU region with a code of its own", person("AX", 31), true],
    ["a name, not a code: unknown", person("United Kingdom", 31), true],
    ["lower case, not a code: unknown", person("gb", 31), true],
    ["three letters, not a code: unknown", person("GBR", 31), true],
    ["empty, not a code: unknown", person("", 31), true],
    ["a name of a country off the list still counts as unknown", person("United States", 31), true],
    [
      "the touch not read: no candidate",
      { createdAt: daysBefore(31), locationCountry: "GB" },
      false,
    ],
  ];
  for (const [name, found, expected] of cases) {
    assert.equal(isCandidate(found, CUTOFF), expected, name);
  }
});

test("the list: the 27 EU members, the EU's regions with codes of their own, the EEA's three and the UK", () => {
  const eu =
    "AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK".split(" ");
  const expected = [...eu, "AX", "GF", "GP", "MF", "MQ", "RE", "YT", "IS", "LI", "NO", "GB"];
  assert.equal(eu.length, 27);
  assert.deepEqual([...RETENTION_EU_UK_COUNTRIES].sort(), expected.sort());
  for (const off of ["CH", "US", "JE", "GG", "IM", "EU", "UK", "EL"]) {
    assert.ok(!RETENTION_EU_UK_COUNTRIES.has(off), `${off} is not on the list`);
  }
});

test("the job's constants", () => {
  assert.deepEqual(
    [RETENTION_MAX_PER_RUN, RETENTION_SWEEP_DELAY_MINUTES, RETENTION_OPERATOR, RETENTION_AT_UTC],
    [1000, 15, "retention", "03:15"],
  );
});
