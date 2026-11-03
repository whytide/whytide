// The anonymizer (docs/security.md "Anonymization"), the unit half of alpha-p6-020's first criterion:
// a fixture person whose record and texts carry names, pronouns, gender, an age, a photo link and an
// address yields the six fields and the excerpts, none of those values in them; then each scrub on
// its own. Pure: no database.
import assert from "node:assert/strict";
import test from "node:test";
import { anonymizeForAssessment } from "../domain/anonymize/index.ts";

const person = {
  firstName: "Adaeze",
  lastName: "Quill-Feather",
  headline:
    "Adaeze Quill-Feather (she/her) | Chairwoman, Head of Revenue Operations | mother of two | https://media.example.com/adaeze.jpg",
  title: "Mrs. Head of Revenue Operations, 41 years old",
  locationCountry: "de",
  // Fields a record may carry and the anonymizer never reads.
  photoUrl: "https://media.example.com/adaeze.jpg",
  pronouns: "she/her",
  gender: "female",
  age: 41,
  birthDate: "1983-04-02",
  religion: "fixture-religion",
  locationText: "Berlin, Germany",
  linkedinUrl: "https://linkedin.com/in/adaeze-quill-feather",
};
const company = {
  name: "Quill & Partners",
  industry: "Women's Health Software",
  sizeRange: "51-200",
};
const evidence = [
  "",
  "She is hiring two SDRs for her team; write to adaeze@quill.example. Born in 1983, female founder.",
  "x".repeat(2000),
  "Fourth",
  "Fifth",
  "Sixth",
];
/** The person's values the model must never see, each matched as a whole word, case aside. */
const FORBIDDEN = [
  "Adaeze",
  "Quill",
  "Feather",
  "she",
  "her",
  "Mrs",
  "Chairwoman",
  "female",
  "mother",
  "41",
  "1983",
  "years old",
  "media.example.com",
  "adaeze.jpg",
  "quill.example",
  "Berlin",
  "linkedin",
  "fixture-religion",
];
const word = (value: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
    "iu",
  );

test("a person yields the six fields and the excerpts, and none of the forbidden values", () => {
  const out = anonymizeForAssessment(person, company, evidence);
  assert.deepEqual(out, {
    profile: {
      headline: "[name] [name]-[name] | Chair, Head of Revenue Operations | parent of two | [link]",
      title: "Head of Revenue Operations",
      country: "Germany (DE)",
    },
    // The company's texts keep their words, which describe its market, not the person.
    company: { name: "[name] & Partners", industry: "Women's Health Software", size: "51-200" },
    // The first five read, an empty one dropped, each cut at 500 characters.
    evidence: [
      "They is hiring two SDRs for their team; write to [email]. founder.",
      "x".repeat(500),
      "Fourth",
      "Fifth",
    ],
  });
  const text = JSON.stringify(out);
  for (const value of FORBIDDEN) assert.doesNotMatch(text, word(value), value);
});

test("names: each part, in any case, with or without its accents; a longer word stays", () => {
  const scrub = (headline: string) =>
    anonymizeForAssessment({ firstName: "Zoë", lastName: "O'Brien-Lee", headline }, null).profile
      .headline;
  assert.equal(
    scrub("ZOE O'BRIEN-LEE and zoë o’brien lee | Leeds"),
    "[name] O'[name]-[name] and [name] o’[name] [name] | Leeds",
  );
  assert.equal(
    scrub("Contact: zoe@obrien.example or www.obrien.example/about"),
    "Contact: [email] or [link]",
  );
});

test("pronouns, honorifics and ages go; a gendered word becomes its neutral one", () => {
  const scrub = (title: string) => anonymizeForAssessment({ title }, null).profile.title;
  const cases: [string, string][] = [
    ["Head of Sales (he/him)", "Head of Sales"],
    ["pronouns: they/them | CTO", "CTO"],
    ["Mr. CFO, aged 52, in his 50s", "CFO"],
    ["Gen Z founder, 24 yrs old, class of 2019", "founder"],
    ["Businesswoman and mom of 3", "Businessperson and parent of 3"],
    [
      "Salesman of the year; she leads men and women",
      "Salesperson of the year; they leads people and people",
    ],
  ];
  for (const [title, expected] of cases) assert.equal(scrub(title), expected, title);
});

test("the country is its English name with its code; anything but a code is null", () => {
  const country = (locationCountry: string | null) =>
    anonymizeForAssessment({ locationCountry }, null).profile.country;
  assert.equal(country("de"), "Germany (DE)");
  assert.equal(country(" at "), "Austria (AT)");
  assert.equal(country("XX"), "XX");
  assert.equal(country("Germany"), null);
  assert.equal(country(null), null);
});

test("no data is null fields and no excerpt, the blocks still there", () => {
  assert.deepEqual(anonymizeForAssessment({}, null), {
    profile: { headline: null, title: null, country: null },
    company: { name: null, industry: null, size: null },
    evidence: [],
  });
});
