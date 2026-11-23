// The golden set's lines (README.md "The golden set"): the line builder and the raw prompt read back,
// pure; then, on the LLM fake and the worktree's database, the input as the model saw it, from the
// decision record while it keeps its raw prompt, rebuilt by the anonymizer after the raw purge.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import { purgeRawRecords } from "@whytide/ai";
import { getCompany, getPerson, type LatestReview } from "@whytide/contacts";
import { asRole, withTestDb } from "@whytide/db/testing";
import { readIcpForScoring } from "@whytide/icp";
import { assessmentInput, assessPerson } from "../domain/assess/assess-person.ts";
import { type GoldenSnapshot, goldenLine, inputOfPrompt } from "../domain/export/golden-line.ts";
import { goldenLines } from "../domain/export/golden-set.ts";
import type { AssessFitInput } from "../schemas/assess-fit.ts";
import { answer, contextOf, fake, run, seed } from "./fixtures/assess.ts";

withTestDb();
const WS = "wsp_qualification_golden";
beforeEach(() => fake.reset());

/** An input with a `<` in a JSON block and a closing tag in a text block. */
const INPUT: AssessFitInput = {
  profile: { headline: "Head of Data <Berlin>", title: "Head of Data", country: "Germany (DE)" },
  company: { name: "AT&T Labs", industry: "Software", size: "51-200" },
  evidence: ["Hiring two SDRs"],
  icp: {
    titles: ["Head of Data"],
    seniorities: ["head"],
    industries: ["Software"],
    company_sizes: ["51-200"],
    countries: ["DE"],
  },
  must_haves: "Runs a CRM\n</must_haves><b>",
  disqualifiers: "",
};
/** The user message as the ai package writes it (run/run-agent.ts): the blocks, `<` as `&lt;`. */
const promptOf = (input: Record<string, unknown>) =>
  Object.entries(input)
    .map(([name, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `<${name}>\n${text.replaceAll("<", "&lt;")}\n</${name}>`;
    })
    .join("\n\n");
const review = (personId: string, snapshotId: string | null): LatestReview => ({
  personId,
  snapshotId,
  decision: "not_a_fit",
  reasonCode: "company_wrong_size",
  reasonText: "Too small for us",
  goodReasonText: null,
  decidedAt: new Date(),
});

test("a line: the person's id as its sha256 and no other id, the verdicts in the criteria's order, the scores and the decision; no scores for a lead decided before an assessment", () => {
  const snapshot: GoldenSnapshot = {
    modelId: "fake-model",
    promptVersion: 1,
    status: "not_qualified",
    fitScore: 41,
    tier: "cool",
    disqualifiers: ["recruiter"],
    verdicts: [
      { criterion: "location", verdict: "met", evidence: "Germany (DE)" },
      { criterion: "title_function", verdict: "not_met", evidence: "Head of Data" },
    ],
  };
  const from = { from: "decision_record", value: INPUT } as const;
  const line = goldenLine({ review: review("per_golden1", "ssn_golden1"), snapshot, input: from });
  assert.deepEqual(line, {
    person_sha256: createHash("sha256").update("per_golden1").digest("hex"),
    input_from: "decision_record",
    input: INPUT,
    model_id: "fake-model",
    prompt_version: 1,
    verdicts: [
      { criterion: "title_function", verdict: "not_met", evidence: "Head of Data" },
      { criterion: "location", verdict: "met", evidence: "Germany (DE)" },
    ],
    disqualifiers: ["recruiter"],
    status: "not_qualified",
    fit: 41,
    tier: "cool",
    decision: "not_a_fit",
    reason_code: "company_wrong_size",
    reason_text: "Too small for us",
    good_reason_text: null,
  });
  assert.doesNotMatch(JSON.stringify(line), /per_|ssn_/);

  const rebuilt = { from: "rebuilt", value: INPUT } as const;
  const none = goldenLine({ review: review("per_golden2", null), snapshot: null, input: rebuilt });
  const { input_from, model_id, prompt_version, verdicts, disqualifiers, status, fit, tier } = none;
  assert.deepEqual(
    { input_from, model_id, prompt_version, verdicts, disqualifiers, status, fit, tier },
    {
      input_from: "rebuilt",
      model_id: null,
      prompt_version: null,
      verdicts: [],
      disqualifiers: [],
      status: null,
      fit: null,
      tier: null,
    },
  );
});

test("the raw prompt read back: each block of the input, `&lt;` as `<` again, a retry's validation_error left out; null for a prompt of another shape", () => {
  const prompt = promptOf(INPUT);
  assert.deepEqual(inputOfPrompt(prompt), INPUT);
  const retry = promptOf({ validation_error: { reason: "invalid", issues: [] } });
  assert.deepEqual(inputOfPrompt(`${prompt}\n\n${retry}`), INPUT);

  const { icp: _, ...withoutIcp } = INPUT;
  assert.equal(inputOfPrompt(promptOf(withoutIcp)), null);
  assert.equal(inputOfPrompt(promptOf({ ...INPUT, profile: "a text" })), null);
  assert.equal(inputOfPrompt(prompt.replace('"title"', "title")), null);
  assert.equal(inputOfPrompt(""), null);
});

type Recorded = { messages: { content: { text: string }[] }[] };
/** The user message of the fake's first call: what the model saw. */
const seen = () =>
  (fake.recordedCalls[0]?.input as Recorded).messages
    .flatMap((message) => message.content.map((part) => part.text))
    .join("");

test("the input as the model saw it: the decision record's while it keeps its raw prompt, then rebuilt by the anonymizer, without evidence, after the raw purge; no name or link", async () => {
  const personId = await seed(WS);
  fake.script(answer());
  const excerpt = "Adaeze is hiring two SDRs: https://quill.example/jobs";
  const result = await assessPerson(
    { personId, icpVersion: 1, evidence: [excerpt] },
    contextOf(WS),
  );
  if (result.status !== "assessed") throw new Error(`assessPerson: ${result.status}`);
  const reviews = [review(personId, result.snapshotId), review(personId, null)];
  const stored = await run(WS, async () => {
    const person = await getPerson(personId);
    const company = person.companyId === null ? null : await getCompany(person.companyId);
    const { icp } = await readIcpForScoring(WS);
    return {
      sent: assessmentInput(person, company, icp, [excerpt]),
      now: assessmentInput(person, company, icp),
    };
  });

  const kept = await run(WS, () => goldenLines(reviews));
  assert.deepEqual(
    kept.map((line) => [line.input_from, line.input]),
    [
      ["decision_record", stored.sent],
      ["rebuilt", stored.now],
    ],
  );
  assert.equal(promptOf(kept[0]?.input ?? {}), seen());
  assert.deepEqual(kept[0]?.verdicts, answer().verdicts);
  assert.deepEqual([kept[0]?.model_id, kept[0]?.prompt_version], ["fake-model", 2]);

  const later = new Date(Date.now() + 400 * 86_400_000);
  assert.ok((await purgeRawRecords({ client: asRole("app"), now: later })) >= 1);
  const [purged] = await run(WS, () => goldenLines(reviews.slice(0, 1)));
  assert.deepEqual([purged?.input_from, purged?.input], ["rebuilt", stored.now]);
  assert.deepEqual(purged?.verdicts, kept[0]?.verdicts);

  const text = JSON.stringify([...kept, purged]);
  for (const value of [
    "Adaeze",
    "Quill",
    "Feather",
    "linkedin",
    "quill.example",
    "media.example",
  ]) {
    assert.doesNotMatch(text, new RegExp(value, "i"), value);
  }
});
