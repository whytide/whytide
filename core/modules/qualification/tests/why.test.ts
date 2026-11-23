// "Why this lead" (docs/concepts.md "The why"), pure: buildWhy's bullets, at most three, a key and
// params only, the data gap only on an unknown, no text but codes and the input's quotes, each worded
// by its message in messages/en.json, a member's verdict named as such; the bullet of a lead the hard
// filters stopped; the cut.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { WhyBullet } from "@whytide/contacts";
import { formatIcu } from "@whytide/platform";
import { HARD_FILTER_REASONS } from "../domain/hard-filters/index.ts";
import type { ScoringCriterion } from "../domain/score/index.ts";
import { buildWhy, cut, type WhyInput } from "../domain/why/index.ts";
import {
  CRITERIA,
  type Criterion,
  DISQUALIFIERS,
  type Disqualifier,
  type Verdict,
} from "../schemas/assess-fit.ts";

const MESSAGES = JSON.parse(
  readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"),
) as Record<string, string>;
const DEFAULTS: ScoringCriterion[] = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];
const QUOTES: Record<Criterion, string> = {
  title_function: "Head of Revenue Operations",
  seniority: "Head of Revenue Operations",
  company_size: "51-200",
  industry: "Software",
  location: "Germany (DE)",
  must_haves: "Runs a sales team on a CRM",
};
/** The six verdicts, `met` unless named, each quoting the person unless unknown. */
const verdicts = (changes: Partial<Record<Criterion, Verdict>> = {}) =>
  CRITERIA.map((criterion) => {
    const verdict = changes[criterion] ?? "met";
    return { criterion, verdict, evidence: verdict === "unknown" ? "" : QUOTES[criterion] };
  });
const input = (given = verdicts(), more: Partial<WhyInput> = {}): WhyInput => ({
  verdicts: given,
  criteria: DEFAULTS,
  disqualifiers: [] as Disqualifier[],
  ...more,
});
const fit = (criterion: Criterion, met: number, total = 6) => ({
  key: "qualification.why.fit",
  params: { criterion, quote: QUOTES[criterion], met, total },
});
const gap = (criterion: Criterion, more: number) => ({
  key: "qualification.why.gap",
  params: { criterion, more },
});

test("buildWhy: at most three bullets of a key and params, the gap only on an unknown, never the model's text", () => {
  const office = verdicts({ title_function: "not_met" }).map((v) =>
    v.criterion === "title_function" ? { ...v, evidence: "Office Manager" } : v,
  );
  const cases: [string, WhyInput, WhyBullet[]][] = [
    [
      "the fit and the gap",
      input(verdicts({ must_haves: "unknown" })),
      [fit("title_function", 5), gap("must_haves", 0)],
    ],
    ["six met: the fit alone", input(), [fit("title_function", 6)]],
    [
      "a disqualifier, a must missed and two unknowns: three, what stops the lead first",
      input(verdicts({ location: "not_met", seniority: "unknown", industry: "unknown" }), {
        disqualifiers: ["recruiter", "competitor"],
      }),
      [
        { key: "qualification.why.disqualified", params: { disqualifier: "competitor" } },
        fit("title_function", 3),
        gap("seniority", 1),
      ],
    ],
    [
      "a must missed, with its quote",
      input(office),
      [
        {
          key: "qualification.why.must_missed",
          params: { criterion: "title_function", quote: "Office Manager" },
        },
        fit("must_haves", 5),
      ],
    ],
    [
      "a disabled criterion: no gap, not counted",
      input(verdicts({ must_haves: "unknown" }), {
        criteria: DEFAULTS.map((c) => (c.key === "must_haves" ? { ...c, enabled: false } : c)),
      }),
      [fit("title_function", 5, 5)],
    ],
    [
      "nothing met: the gap alone",
      input(verdicts(Object.fromEntries(CRITERIA.map((c) => [c, "unknown" as Verdict])))),
      [gap("title_function", 5)],
    ],
    [
      "members' verdicts (README \"A member's verdict\"): named as a member's, never quoted",
      input(
        verdicts({ location: "not_met" }).map((v) =>
          v.criterion === "location" || v.criterion === "title_function"
            ? { ...v, evidence: "", byMember: true }
            : v,
        ),
      ),
      [
        {
          key: "qualification.why.must_missed_member",
          params: { criterion: "location" },
        },
        {
          key: "qualification.why.fit_member",
          params: { criterion: "title_function", met: 5, total: 6 },
        },
      ],
    ],
  ];
  const codes = new Set<string>([...CRITERIA, ...DISQUALIFIERS, ...HARD_FILTER_REASONS]);
  for (const [name, given, expected] of cases) {
    const bullets = buildWhy(given);
    assert.deepEqual(bullets, expected, name);
    assert.ok(bullets.length <= 3, name);
    const quotes = new Set(given.verdicts.map((verdict) => verdict.evidence));
    for (const { key, params = {} } of bullets) {
      const values = Object.values(params);
      assert.ok(values.length <= 10, name);
      for (const value of values) {
        // A number, a code of a closed list or a quote of the input: no sentence of the model's.
        const quoted = typeof value === "string" && (codes.has(value) || quotes.has(value));
        assert.ok(typeof value === "number" || quoted, `${name}: ${value}`);
      }
      const message = MESSAGES[key];
      assert.ok(message, `${name}: ${key} in messages/en.json`);
      assert.ok(formatIcu(message, params, "en").length > 0, `${name}: ${key} worded`);
    }
  }
});

test("a lead the hard filters stopped: one bullet, the ICP's list cut to 300 code points; a quote cut on a code point", () => {
  const titles = Array.from({ length: 50 }, (_, i) => `Head of Revenue Operations ${i + 1}`);
  const detail = { value: "Office Manager", icp: titles };
  const hardFilter = { reason: "title_mismatch" as const, detail };
  const bullets = buildWhy({ verdicts: [], criteria: [], disqualifiers: [], hardFilter });
  assert.equal(bullets.length, 1);
  const [{ key, params } = { key: "" }] = bullets;
  assert.equal(key, "qualification.why.hard_filtered");
  const icp = String(params?.icp);
  assert.deepEqual(
    { ...params, icp: "" },
    { reason: "title_mismatch", value: "Office Manager", icp: "" },
  );
  assert.equal([...icp].length, 300);
  assert.ok(icp.endsWith("…") && titles.join(", ").startsWith(icp.slice(0, -1)));
  assert.match(formatIcu(MESSAGES[key] ?? "", params ?? {}, "en"), /^The title “Office Manager”/);

  const emoji = cut("😀".repeat(400));
  assert.equal([...emoji].length, 300);
  assert.ok(emoji.isWellFormed());
  assert.equal(cut("51-200"), "51-200");
});
