// The score, fit-v1 (docs/concepts.md "The score"), pure: computeFit's twelve cases, decide's rules,
// and the golden file of the scorer version, which fails when a result of that version changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Confidence,
  computeFit,
  decide,
  SCORER_VERSION,
  type ScoredVerdict,
  type ScoringCriterion,
} from "../domain/score/index.ts";
import {
  CRITERIA,
  type Criterion,
  type Disqualifier,
  type Verdict,
} from "../schemas/assess-fit.ts";

/** icp's defaults (decisions.md): F04 §4.3's weights by key; title/function and location are musts. */
const DEFAULTS: ScoringCriterion[] = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];
/** The defaults with one criterion disabled. */
const off = (key: Criterion) => DEFAULTS.map((c) => (c.key === key ? { ...c, enabled: false } : c));
/** The six verdicts, `met` unless named. */
const verdicts = (changes: Partial<Record<Criterion, Verdict>> = {}): ScoredVerdict[] =>
  CRITERIA.map((criterion) => ({ criterion, verdict: changes[criterion] ?? "met" }));

test("computeFit: weights, points, the must cap and confidence over the criteria that count, in twelve cases", () => {
  const unknown = "unknown";
  const partly = "partially_met";
  const cases: [string, ScoredVerdict[], ScoringCriterion[], [number, Confidence, number]][] = [
    ["six met", verdicts(), DEFAULTS, [100, "high", 0]],
    [
      "title_function not_met: 70 capped",
      verdicts({ title_function: "not_met" }),
      DEFAULTS,
      [40, "high", 0],
    ],
    ["location not_met: 90 capped", verdicts({ location: "not_met" }), DEFAULTS, [40, "high", 0]],
    ["one unknown", verdicts({ must_haves: unknown }), DEFAULTS, [88, "high", 1]],
    [
      "two unknown",
      verdicts({ company_size: unknown, must_haves: unknown }),
      DEFAULTS,
      [82, "medium", 2],
    ],
    [
      "three unknown",
      verdicts({ seniority: unknown, industry: unknown, must_haves: unknown }),
      DEFAULTS,
      [70, "low", 3],
    ],
    [
      "partially met",
      verdicts({ seniority: partly, company_size: partly, industry: partly, must_haves: partly }),
      DEFAULTS,
      [70, "high", 0],
    ],
    [
      "59.5 rounds half up",
      verdicts({
        seniority: partly,
        company_size: unknown,
        industry: "not_met",
        must_haves: unknown,
      }),
      DEFAULTS,
      [60, "medium", 2],
    ],
    [
      "no must_haves verdict: the five present",
      verdicts().filter(({ criterion }) => criterion !== "must_haves"),
      DEFAULTS,
      [100, "high", 0],
    ],
    [
      "must_haves disabled at not_met",
      verdicts({ must_haves: "not_met" }),
      off("must_haves"),
      [100, "high", 0],
    ],
    [
      "a disabled criterion's unknown counts for nothing",
      verdicts({ must_haves: unknown, industry: "not_met" }),
      off("must_haves"),
      [81, "high", 0],
    ],
    [
      "a disabled must caps nothing",
      verdicts({ location: "not_met" }),
      off("location"),
      [100, "high", 0],
    ],
  ];
  assert.equal(cases.length, 12);
  for (const [name, given, criteria, [fit, confidence, unknownCount]] of cases) {
    assert.deepEqual(computeFit(given, criteria), { fit, confidence, unknownCount }, name);
  }
});

test("decide: a disqualifier blocks at any fit; the gate at 60; review above it; the tier from the fit", () => {
  const at = (fit: number, given = verdicts(), confidence: Confidence = "high") => ({
    fit,
    confidence,
    verdicts: given,
    criteria: DEFAULTS,
    disqualifiers: [] as Disqualifier[],
  });
  const cases: [string, Parameters<typeof decide>[0], ReturnType<typeof decide>][] = [
    [
      "a disqualifier at 100",
      { ...at(100), disqualifiers: ["recruiter"] },
      { status: "not_qualified", tier: "hot", reason: "recruiter" },
    ],
    ["59", at(59), { status: "not_qualified", tier: "cool", reason: null }],
    [
      "60, location unknown",
      at(60, verdicts({ location: "unknown" })),
      { status: "needs_review", tier: "warm", reason: null },
    ],
    ["80, high", at(80), { status: "qualified", tier: "hot", reason: null }],
    ["74", at(74), { status: "qualified", tier: "warm", reason: null }],
    ["75", at(75), { status: "qualified", tier: "hot", reason: null }],
    ["70, low", at(70, verdicts(), "low"), { status: "needs_review", tier: "warm", reason: null }],
    [
      "59, location unknown: review is above the gate only",
      at(59, verdicts({ location: "unknown" })),
      { status: "not_qualified", tier: "cool", reason: null },
    ],
    [
      "80, location unknown but disabled",
      { ...at(80, verdicts({ location: "unknown" })), criteria: off("location") },
      { status: "qualified", tier: "hot", reason: null },
    ],
  ];
  for (const [name, input, expected] of cases) assert.deepEqual(decide(input), expected, name);
});

type Golden = {
  scorer: string;
  criteria: ScoringCriterion[];
  cases: {
    name: string;
    criteria?: ScoringCriterion[];
    verdicts: Record<Criterion, Verdict>;
    disqualifiers: Disqualifier[];
    expected: unknown;
  }[];
};

test("the golden file: ten verdict sets give the scorer version's stored results", () => {
  const file = new URL(`./fixtures/golden/${SCORER_VERSION}.json`, import.meta.url);
  const golden = JSON.parse(readFileSync(file, "utf8")) as Golden;
  assert.equal(golden.scorer, SCORER_VERSION);
  assert.equal(golden.cases.length, 10);
  for (const { name, verdicts: given, disqualifiers, expected, ...rest } of golden.cases) {
    const criteria = rest.criteria ?? golden.criteria;
    const scored = CRITERIA.map((criterion) => ({ criterion, verdict: given[criterion] }));
    const fit = computeFit(scored, criteria);
    const decision = decide({ ...fit, disqualifiers, verdicts: scored, criteria });
    assert.deepEqual({ ...fit, ...decision }, expected, name);
  }
});

test("about the hot threshold, from the verdicts: 74 is warm and 75 hot; every criterion disabled is 0, not_qualified", () => {
  const cases: [Partial<Record<Criterion, Verdict>>, number, "warm" | "hot"][] = [
    // 300 + 60 + 0 + 75 + 100 + 200 of 1000 tenths: 73.5 rounds to 74.
    [{ seniority: "unknown", industry: "partially_met", company_size: "not_met" }, 74, "warm"],
    [{ seniority: "partially_met", industry: "partially_met", company_size: "not_met" }, 75, "hot"],
  ];
  for (const [changes, fit, tier] of cases) {
    const given = verdicts(changes);
    const scored = computeFit(given, DEFAULTS);
    assert.equal(scored.fit, fit);
    const decision = decide({ ...scored, disqualifiers: [], verdicts: given, criteria: DEFAULTS });
    assert.deepEqual(decision, { status: "qualified", tier, reason: null });
  }
  const none = DEFAULTS.map((criterion) => ({ ...criterion, enabled: false }));
  const nothing = computeFit(verdicts(), none);
  assert.deepEqual(nothing, { fit: 0, confidence: "high", unknownCount: 0 });
  const decision = decide({ ...nothing, disqualifiers: [], verdicts: verdicts(), criteria: none });
  assert.deepEqual(decision, { status: "not_qualified", tier: "cool", reason: null });
});
