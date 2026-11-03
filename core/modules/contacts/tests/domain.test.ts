// contacts' rules in domain/ (alpha-p5-010, alpha-p5-020, alpha-p9-040, alpha-p9-050): the URL
// normalization, the salted hash and its kind prefix, the provenance merge, the country of a location,
// the expiry of a hash, a lead's source merge, the list's cursor, the weekly review summary and the
// CSV's cells. Pure: no database.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { throwsCode } from "@whytide/platform";
import { countryCode, countryOf } from "../domain/countries.ts";
import { csvLine, neutralize } from "../domain/export/csv.ts";
import { hashOf, nextHash } from "../domain/hash.ts";
import { decodeCursor, encodeCursor, type LeadSort, mergeSource } from "../domain/lead.ts";
import {
  normalizeCompanyLinkedinUrl,
  normalizeDomain,
  normalizeLinkedinUrl,
} from "../domain/linkedin-url.ts";
import { mergeFields, splitName } from "../domain/provenance.ts";
import {
  summarize,
  topTwenty,
  type WeekDecision,
  type WeekLead,
  weekRange,
} from "../domain/review/summary.ts";
import { useHashSalt } from "../testing/index.ts";

test("a LinkedIn profile URL normalizes to https://linkedin.com/in/<slug>, lowercased; anything else is null, which the lead page links never (ui/lead/view.tsx)", () => {
  const same = [
    "https://www.linkedin.com/in/Ada-Example-1",
    "http://linkedin.com/in/ada-example-1/",
    "HTTPS://WWW.LinkedIn.com/IN/ada-example-1/?trk=public#about",
    "  www.linkedin.com/in/ada-example-1  ",
    "linkedin.com/in/ada-example-1",
  ];
  for (const url of same)
    assert.equal(normalizeLinkedinUrl(url), "https://linkedin.com/in/ada-example-1", url);
  assert.equal(
    normalizeLinkedinUrl("https://www.linkedin.com/in/%C3%A9l%C3%A8ne"),
    "https://linkedin.com/in/%c3%a9l%c3%a8ne",
  );
  const none = [
    "",
    "ada-example-1",
    "https://linkedin.com/company/blue-harbor",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/in/ada-example-1/details/experience",
    "https://uk.linkedin.com/in/ada-example-1",
    "https://linkedin.com.example.com/in/ada-example-1",
    "https://ada@linkedin.com/in/ada-example-1",
    "https://linkedin.com:8443/in/ada-example-1",
    "ftp://linkedin.com/in/ada-example-1",
    "javascript:alert(1)",
  ];
  for (const url of none) assert.equal(normalizeLinkedinUrl(url), null, url);
  assert.equal(
    normalizeCompanyLinkedinUrl("https://www.linkedin.com/company/Blue-Harbor/"),
    "https://linkedin.com/company/blue-harbor",
  );
  assert.equal(
    normalizeDomain("https://WWW.Blue-Harbor.example.com/about"),
    "blue-harbor.example.com",
  );
  assert.equal(normalizeDomain("not a domain"), null);
});

test("hashOf: HMAC-SHA-256 under the salt of the value prefixed with its kind, url: or pid:; one hash per value, none without a salt", () => {
  const salt = "test-salt-".repeat(4);
  const hmac = (input: string) => createHmac("sha256", salt).update(input).digest("hex");
  useHashSalt(salt);
  const url = "https://linkedin.com/in/ada-example-1";
  const hash = hashOf("url", url);
  assert.equal(hash, hmac(`url:${url}`));
  assert.equal(hashOf("pid", "synthetic-member-1"), hmac("pid:synthetic-member-1"));
  assert.notEqual(hashOf("pid", url), hash, "a provider id and a URL of the same text, two hashes");
  assert.notEqual(hashOf("url", "https://linkedin.com/in/ada-example-2"), hash);
  useHashSalt("other-salt-".repeat(4));
  assert.notEqual(hashOf("url", url), hash, "another salt, another hash");
  useHashSalt(undefined);
  throwsCode(() => hashOf("url", url), "hash_salt_missing");
});

test("the provenance merge: a value brought takes its stamp unless the stored one is newer; one not brought, or empty, keeps both", () => {
  const at = (day: number) => `2026-10-0${day}T08:00:00.000Z`;
  const linkedin = { source: "linkedin", provider: "unipile", at: at(2) } as const;
  const stored = { title: linkedin, headline: linkedin, firstName: linkedin };
  const csv = { source: "import", provider: "csv", at: at(3) } as const;
  const newer = mergeFields(stored, { title: "VP Data", headline: "", firstName: undefined }, csv);
  assert.deepEqual(newer.values, { title: "VP Data" });
  assert.deepEqual(newer.provenance, { title: csv, headline: linkedin, firstName: linkedin });
  const older = mergeFields(
    stored,
    { title: "Analyst", lastName: "Example" },
    { ...csv, at: at(1) },
  );
  assert.deepEqual(older.values, { lastName: "Example" });
  assert.deepEqual(older.provenance.title, linkedin);
  assert.deepEqual(splitName(" Maria  de la Cruz "), {
    firstName: "Maria",
    lastName: "de la Cruz",
  });
  assert.deepEqual(splitName("Ada"), { firstName: "Ada", lastName: undefined });
});

test("the country of a location: its last part, or the whole, by ICU's English names and the usual others", () => {
  const cases: [string, string | null][] = [
    ["London, England, United Kingdom", "GB"],
    ["Berlin, Germany", "DE"],
    ["Bengaluru, Karnataka, India", "IN"],
    ["Istanbul, Turkey", "TR"],
    ["Istanbul, Türkiye", "TR"],
    ["Abidjan, Cote d'Ivoire", "CI"],
    ["Basseterre, Saint Kitts and Nevis", "KN"],
    ["Hong Kong SAR", "HK"],
    ["United States", "US"],
    ["San Francisco Bay Area", null],
    ["", null],
  ];
  for (const [location, code] of cases) assert.equal(countryOf(location), code, location);
  assert.deepEqual(
    [countryCode("de"), countryCode("Germany"), countryCode("QQ")],
    ["DE", "DE", null],
  );
});

test("a hash's expiry: 90 days for a rejected candidate, not moved by a later rejection; never for an erased person", () => {
  const day = 86_400_000;
  const now = new Date("2026-10-22T00:00:00Z");
  const rejected = nextHash(null, "rejected_candidate", ["hard_filter"], now);
  assert.equal(rejected.expiresAt?.getTime(), now.getTime() + 90 * day);
  const later = new Date(now.getTime() + 10 * day);
  const again = nextHash(rejected, "rejected_candidate", ["hard_filter", "noise"], later);
  assert.deepEqual(
    [again.expiresAt, again.dropReasons],
    [rejected.expiresAt, { hard_filter: 2, noise: 1 }],
  );
  const erased = nextHash(again, "erased", [], later);
  assert.deepEqual([erased.kind, erased.expiresAt], ["erased", null]);
  assert.equal(nextHash(erased, "rejected_candidate", ["noise"], later).kind, "erased");
  const expired = nextHash(
    rejected,
    "rejected_candidate",
    ["noise"],
    new Date(now.getTime() + 91 * day),
  );
  assert.deepEqual(expired.dropReasons, { noise: 1 }, "an expired hash counts as none");
});

test("a lead's source merge: a new kind and ref is appended after the others; the same one again changes nothing", () => {
  const imported = { kind: "imported", ref: "imp_1", at: "2026-10-01T08:00:00.000Z" } as const;
  const signal = { kind: "signal", ref: "sig_1", at: "2026-10-02T08:00:00.000Z" } as const;
  const both = mergeSource(mergeSource([], imported), signal);
  assert.deepEqual(both, [imported, signal]);
  assert.equal(mergeSource(both, { ...signal, at: "2026-10-03T08:00:00.000Z" }), both);
  assert.deepEqual(mergeSource(both, { ...imported, ref: "imp_2" }).at(-1), {
    ...imported,
    ref: "imp_2",
  });
});

test("the lead list's cursor: base64url of the sort keys and the person id, read back in its own sort only; a malformed one is null", () => {
  const lead = {
    personId: "per_01",
    fitScore: 87,
    createdAt: new Date("2026-10-22T08:00:00.123Z"),
    reviewStatus: null,
  };
  const byFit = encodeCursor("fit", lead);
  assert.match(byFit, /^[\w-]+$/);
  assert.deepEqual(decodeCursor("fit", byFit), { sort: "fit", fitScore: 87, personId: "per_01" });
  const unscored = encodeCursor("fit", { ...lead, fitScore: null });
  assert.deepEqual(decodeCursor("fit", unscored), {
    sort: "fit",
    fitScore: null,
    personId: "per_01",
  });
  const newest = encodeCursor("newest", lead);
  const at = { sort: "newest", createdAt: lead.createdAt, personId: "per_01" };
  assert.deepEqual(decodeCursor("newest", newest), at);
  const unreviewed = encodeCursor("unreviewed_first", lead);
  assert.deepEqual(decodeCursor("unreviewed_first", unreviewed), {
    sort: "unreviewed_first",
    reviewStatus: null,
    fitScore: 87,
    personId: "per_01",
  });
  const reviewed = encodeCursor("unreviewed_first", {
    ...lead,
    reviewStatus: "not_a_fit",
  });
  assert.equal(
    (decodeCursor("unreviewed_first", reviewed) as { reviewStatus: unknown }).reviewStatus,
    "not_a_fit",
  );
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const malformed: [LeadSort, string][] = [
    ["fit", newest],
    ["newest", byFit],
    ["fit", ""],
    ["fit", "not a cursor"],
    ["fit", encode(["fit", 101, "per_01"])],
    ["fit", encode(["fit", "87", "per_01"])],
    ["fit", encode(["fit", 87, ""])],
    ["fit", encode({ sort: "fit", fitScore: 87, personId: "per_01" })],
    ["newest", encode(["newest", "yesterday", "per_01"])],
    ["fit", unreviewed],
    ["unreviewed_first", byFit],
    ["unreviewed_first", encode(["unreviewed_first", "maybe", 87, "per_01"])],
    ["unreviewed_first", encode(["unreviewed_first", 87, "per_01"])],
  ];
  for (const [sort, cursor] of malformed) assert.equal(decodeCursor(sort, cursor), null, cursor);
});

test("the weekly summary: an ISO week in UTC; its top twenty qualified leads by fit, 12 good of 20 is 0.6; its decisions by the latest per lead", () => {
  const utc = (day: string) => new Date(`${day}T00:00:00Z`);
  assert.deepEqual(weekRange("2026-W40"), { start: utc("2026-09-28"), end: utc("2026-10-05") });
  assert.deepEqual(weekRange("2026-W01"), { start: utc("2025-12-29"), end: utc("2026-01-05") });
  assert.deepEqual(weekRange("2026-W53")?.start, utc("2026-12-28"));
  for (const week of ["2025-W53", "2026-W00", "2026-W54", "2026-43", "2026-W4"])
    assert.equal(weekRange(week), null, week);

  const tied = [
    { personId: "per_a", fitScore: 50, reviewStatus: null },
    { personId: "per_c", fitScore: null, reviewStatus: null },
    { personId: "per_b", fitScore: 50, reviewStatus: null },
    { personId: "per_d", fitScore: 60, reviewStatus: null },
  ];
  const order = topTwenty(tied).map((lead) => lead.personId);
  assert.deepEqual(order, ["per_d", "per_b", "per_a", "per_c"]);

  // 25 qualified leads, fit 99 down to 75: the first 12 good, the next 5 not a fit, 3 unreviewed;
  // past the twentieth, 21 and 22 are good, which the rate leaves out.
  const status = (i: number): WeekLead["reviewStatus"] =>
    i < 12 || i === 21 || i === 22 ? "good_lead" : i < 17 || i > 22 ? "not_a_fit" : null;
  const id = (i: number) => `per_${String(i).padStart(2, "0")}`;
  const leads = Array.from({ length: 25 }, (_, i) => ({
    personId: id(i),
    fitScore: 99 - i,
    reviewStatus: status(i),
  }));
  assert.deepEqual(
    topTwenty(leads).map((lead) => lead.personId),
    leads.slice(0, 20).map((lead) => lead.personId),
  );
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 30, 9, minute));
  const reason = (i: number) =>
    i < 12 || i === 21 || i === 22
      ? null
      : i < 15
        ? "company_wrong_size"
        : "contact_wrong_seniority";
  const week: WeekDecision[] = [...Array.from({ length: 17 }, (_, i) => i), 21, 22].map((i) => ({
    id: `rvd_${id(i)}`,
    personId: id(i),
    decision: reason(i) === null ? "good_lead" : "not_a_fit",
    reasonCode: reason(i),
    decidedAt: at(i),
  }));
  // Lead 23 was good, then not a fit: the latest counts, whatever the order of the rows.
  week.unshift({
    id: "rvd_b",
    personId: id(23),
    decision: "not_a_fit",
    reasonCode: "other",
    decidedAt: at(40),
  });
  week.push({
    id: "rvd_a",
    personId: id(23),
    decision: "good_lead",
    reasonCode: null,
    decidedAt: at(30),
  });

  const summary = summarize(leads, week);
  assert.deepEqual(summary.top20, { count: 20, goodLeads: 12, reviewed: 17, rate: 0.6 });
  assert.deepEqual([summary.decided, summary.goodLeads, summary.notAFit], [20, 14, 6]);
  const named = Object.entries(summary.byReason).filter(([, count]) => count > 0);
  assert.deepEqual(Object.fromEntries(named), {
    company_wrong_size: 3,
    contact_wrong_seniority: 2,
    other: 1,
  });
  assert.equal(Object.keys(summary.byReason).length, 15);
  const none = summarize([], []);
  assert.deepEqual(none.top20, { count: 0, goodLeads: 0, reviewed: 0, rate: null });
  assert.equal(none.decided, 0);
});

test("a CSV cell a spreadsheet would run gets a leading apostrophe: =, +, -, @, a tab or a carriage return first; a comma, a quote or a break quotes it", () => {
  for (const formula of ["=SUM(A1)", "+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"])
    assert.equal(neutralize(formula), `'${formula}`, JSON.stringify(formula));
  for (const text of ["SUM(A1)", "a=b", "", "Blue Harbor Labs"])
    assert.equal(neutralize(text), text);
  const cells = ["=SUM(A1)", 'Says "hi", twice', null, 82, "one\ntwo", "\r=1"];
  assert.equal(csvLine(cells), `'=SUM(A1),"Says ""hi"", twice",,82,"one\ntwo","'\r=1"\r\n`);
});
