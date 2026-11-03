// The assessment's checks in code (docs/concepts.md "The assessment"): the gate, each criterion
// exactly once, which returns issues and never throws or changes the output; the grounding after the
// call, which makes a verdict unknown when its evidence shares no word with the person's data, the
// ICP's never counting; and the output schema's closed lists. Pure: no database.
import assert from "node:assert/strict";
import test from "node:test";
import type { CriterionKey } from "@whytide/icp";
import { criteriaGate, groundVerdicts } from "../domain/assess/checks.ts";
import {
  type AssessFitInput,
  type AssessFitOutput,
  assessFitOutput,
  type Criterion,
  type CriterionVerdict,
} from "../schemas/assess-fit.ts";

const input: AssessFitInput = {
  profile: {
    headline: "[name] | Head of Revenue Operations",
    title: null,
    country: "Germany (DE)",
  },
  company: { name: "Blue Harbor Labs", industry: "Software", size: "51-200" },
  evidence: ["Hiring two SDRs in Zürich"],
  icp: {
    titles: ["VP Sales"],
    seniorities: ["vp"],
    industries: ["Fintech"],
    company_sizes: ["201-500"],
    countries: ["AT"],
  },
  must_haves: "Uses a CRM",
  disqualifiers: "",
};
const output = (verdicts: AssessFitOutput["verdicts"]): AssessFitOutput => ({
  verdicts,
  disqualifiers: [],
  summary: "One sentence.",
});
const valid = output([
  { criterion: "title_function", verdict: "met", evidence: "head of revenue operations" },
  { criterion: "seniority", verdict: "partially_met", evidence: "Head" },
  { criterion: "company_size", verdict: "not_met", evidence: "51-200" },
  { criterion: "industry", verdict: "met", evidence: "software" },
  { criterion: "location", verdict: "not_met", evidence: "Germany" },
  { criterion: "must_haves", verdict: "partially_met", evidence: "hiring SDRs in Zurich" },
]);

test("icp's six criteria are the schema's, both ways", () => {
  const same: [CriterionKey] extends [Criterion]
    ? [Criterion] extends [CriterionKey]
      ? true
      : never
    : never = true;
  assert.equal(same, true);
});

test("the gate: each criterion once passes; twice or missing is an issue, never a throw", () => {
  assert.deepEqual(criteriaGate(valid), { gate: "criteria", issues: [] });
  const [title, ...others] = valid.verdicts as [CriterionVerdict, ...CriterionVerdict[]];
  const doubled = Object.freeze(output([title, title, ...others.slice(0, 4)]));
  assert.deepEqual(criteriaGate(doubled).issues, [
    { path: "verdicts", message: "title_function: 2 verdicts, one expected" },
    { path: "verdicts", message: "must_haves: 0 verdicts, one expected" },
  ]);
  assert.equal(criteriaGate(output([])).issues.length, 6);
});

test("grounding: evidence that quotes the person's data keeps its verdict, in the criteria's order", () => {
  const reversed = output([...valid.verdicts].reverse());
  assert.deepEqual(groundVerdicts(reversed, input), valid.verdicts);
});

test("grounding: no shared word, the ICP's words only, placeholders or none is unknown", () => {
  const verdicts = groundVerdicts(
    output([
      { criterion: "title_function", verdict: "met", evidence: "VP Sales" },
      { criterion: "seniority", verdict: "met", evidence: "Leading innovator" },
      { criterion: "company_size", verdict: "met", evidence: "" },
      { criterion: "industry", verdict: "met", evidence: "[name] of the" },
      { criterion: "location", verdict: "unknown", evidence: "Germany" },
      { criterion: "must_haves", verdict: "met", evidence: "Uses a CRM" },
    ]),
    input,
  );
  for (const verdict of verdicts) {
    assert.deepEqual(
      { ...verdict, criterion: "" },
      { criterion: "", verdict: "unknown", evidence: "" },
    );
  }
});

test("the schema: a verdict, a criterion or a disqualifier off its closed list fails", () => {
  assert.equal(assessFitOutput.safeParse(valid).success, true);
  const [title, ...others] = valid.verdicts as [CriterionVerdict, ...CriterionVerdict[]];
  const off = [
    output([{ ...title, verdict: "maybe" } as never, ...others]),
    output([...valid.verdicts, { criterion: "budget", verdict: "met", evidence: "x" } as never]),
    { ...valid, disqualifiers: ["bad_vibes"] },
  ];
  for (const answer of off) assert.equal(assessFitOutput.safeParse(answer).success, false);
});
