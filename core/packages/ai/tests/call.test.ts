// callAgent end to end (README.md "Calling an agent", "Decision records"): the fixture task on the
// LLM fake, the decision records and cost events in this file's schema of the worktree's database.
import assert from "node:assert/strict";
import { join } from "node:path";
import { beforeEach, it } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import type { PriceTable } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import {
  type AgentTask,
  callAgent,
  checkAgentPrices,
  loadAgentTasks,
  registeredAgentTasks,
} from "../index.ts";
import { listTaskFiles } from "../registry/generate.ts";

withTestDb();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
await loadAgentTasks(listTaskFiles(join(import.meta.dirname, "fixtures/registry")));
const task = registeredAgentTasks().get("fixture.assess") as AgentTask;
const prices: PriceTable = {
  version: "test-prices",
  prices: { fake: { "fake-model": { input_tokens: 0.001, output_tokens: 0.002 } } },
};
const evidence = ["Hiring a data lead, https://example.com/jobs/data-lead.png"];
const call = { workspaceId: "wsp_call", subjectRef: "per_a", input: { profile: "CTO", evidence } };
const options = () => ({ client: asRole("app"), prices });
const run = (t: AgentTask = task, subjectRef = "per_a") =>
  callAgent(t, { ...call, subjectRef }, options());
const records = () => asRole("app").decisionRecord.findMany({ orderBy: { createdAt: "asc" } });
const costs = () => asRole("app").costEvent.findMany({ orderBy: { createdAt: "asc" } });
type Part = { type: string; text?: string };
/** The parts of each model call's messages, the system prompt aside. */
const sent = () =>
  fake.recordedCalls.map(({ input }) =>
    (input as { messages: { content: Part[] }[] }).messages.flatMap((m) => m.content),
  );

beforeEach(() => fake.reset());

it("retries an invalid answer with its error in a data block, then returns the valid one", async () => {
  fake.script({ verdict: "maybe" }, { verdict: "met" });
  const result = await run();
  assert.deepEqual(result.status === "ok" && [result.output, result.attempts, result.cached], [
    { verdict: "met" },
    2,
    false,
  ]);
  const [first, second, ...more] = sent();
  assert.equal(more.length, 0);
  // Text parts only: the URL in the evidence reaches the model as text, never as a file part.
  assert.ok([...(first ?? []), ...(second ?? [])].every((part) => part.type === "text"));
  const [one = "", two = ""] = [first?.[0]?.text, second?.[0]?.text];
  const open = "\n\n<validation_error>\n";
  assert.ok(two.startsWith(`${one}${open}`) && two.endsWith("\n</validation_error>"));
  const block = JSON.parse(two.slice(one.length + open.length, -"\n</validation_error>".length));
  assert.deepEqual(
    [block.attempt, block.reason, block.issues.map((i: { path: string }) => i.path)],
    [1, "invalid", ["verdict"]],
  );
  const [record] = await records();
  assert.equal(record?.id, result.decisionRecordId);
  assert.deepEqual(
    [record?.status, record?.attempts, record?.output, record?.rawPrompt, record?.rawOutput],
    ["ok", 2, { verdict: "met" }, two, '{"verdict":"met"}'],
  );
  assert.deepEqual(record?.gates, [block]);
  const days = (Number(record?.rawPurgeAfter) - Number(record?.createdAt)) / 86_400_000;
  assert.equal(days, 30);
});

it("answers ai_failed after a second invalid answer, records it and makes no third call", async () => {
  fake.script({ verdict: "maybe" }, { verdict: "perhaps" }, { verdict: "met" });
  const result = await run();
  const { decisionRecordId } = result;
  assert.deepEqual(result, {
    status: "ai_failed",
    reason: "invalid",
    decisionRecordId,
    attempts: 2,
    cached: false,
  });
  assert.equal(fake.recordedCalls.length, 2);
  const [record, ...more] = await records();
  assert.equal(more.length, 0);
  assert.deepEqual(
    [record?.id, record?.status, record?.output, record?.attempts],
    [decisionRecordId, "ai_failed", null, 2],
  );
  const gates = record?.gates as { attempt: number; reason: string }[];
  assert.deepEqual(
    gates.map((gate) => [gate.attempt, gate.reason]),
    [
      [1, "invalid"],
      [2, "invalid"],
    ],
  );
});

it("takes a failed gate as a failed validation: retried with its issues, recorded in gates", async () => {
  fake.script({ verdict: "met" }, { verdict: "not_met" });
  const input = { profile: "CTO", evidence: [] };
  const result = await callAgent(task, { ...call, subjectRef: "per_gate", input }, options());
  assert.deepEqual(result.status === "ok" && [result.output, result.attempts], [
    { verdict: "not_met" },
    2,
  ]);
  const message = "met needs at least one evidence item";
  const issues = [{ gate: "evidence", path: "verdict", message }];
  const failure = { attempt: 1, reason: "gates", issues };
  const text = sent()[1]?.[0]?.text ?? "";
  const open = "<validation_error>\n";
  const block = text.slice(text.indexOf(open) + open.length, -"\n</validation_error>".length);
  assert.deepEqual(JSON.parse(block), failure);
  const [record] = await records();
  assert.deepEqual(record?.gates, [failure]);
});

it("returns the cached output of the same call without a model call; a new prompt version calls", async () => {
  fake.script({ verdict: "met" });
  const first = await run();
  const second = await run();
  assert.deepEqual(second, { ...first, cached: true });
  assert.equal(fake.recordedCalls.length, 1);
  assert.equal((await costs()).length, 1);
  fake.script({ verdict: "not_met" });
  const next = await run({ ...task, promptVersion: 2 });
  assert.deepEqual(next.status === "ok" && [next.output, next.cached], [
    { verdict: "not_met" },
    false,
  ]);
  assert.equal(fake.recordedCalls.length, 2);
});

it("takes a cached output that no longer parses as a miss: the model answers, the record is replaced", async () => {
  fake.script({ verdict: "met" }, { verdict: "not_met" });
  const first = await run();
  await asRole("app").decisionRecord.updateMany({ data: { output: { verdict: "maybe" } } });
  const second = await run();
  assert.deepEqual(
    second.status === "ok" && [second.output, second.cached, second.decisionRecordId],
    [{ verdict: "not_met" }, false, first.decisionRecordId],
  );
  assert.equal(fake.recordedCalls.length, 2);
  assert.deepEqual(
    (await records()).map((row) => row.output),
    [{ verdict: "not_met" }],
  );
});

it("writes exactly one cost event per call, ok or ai_failed, with its tokens and subject_ref", async () => {
  fake.script({ verdict: "met" }, { verdict: "maybe" }, { verdict: "maybe" });
  await run(task, "per_ok");
  await run(task, "per_failed");
  const events = await costs();
  const byRecord = (await records()).map((record) => [
    record.subjectRef,
    { input_tokens: record.inputTokens, output_tokens: record.outputTokens },
    record.costCredits.toString(),
  ]);
  assert.deepEqual(
    events.map((event) => [event.subjectRef, event.units, event.unitCost.toString()]),
    byRecord,
  );
  for (const event of events) {
    assert.deepEqual(
      [event.workspaceId, event.feature, event.task, event.vendor, event.model],
      ["wsp_call", "fixture", "fixture.assess", "fake", "fake-model"],
    );
    assert.ok(Number(event.unitCost) > 0);
  }
  assert.deepEqual(
    events.map((event) => event.subjectRef),
    ["per_ok", "per_failed"],
  );
});

it("throws the port's llm_rate_limited without an ai_failed record", async () => {
  fake.failNext("llm_rate_limited");
  await assert.rejects(run(), { code: "llm_rate_limited" });
  assert.deepEqual(await records(), []);
  // No model call answered, so no tokens and no cost event.
  assert.deepEqual(await costs(), []);
});

it("checks at start that every registered task's model is priced", async () => {
  await checkAgentPrices(prices);
  await assert.rejects(checkAgentPrices({ version: "empty", prices: {} }), {
    code: "cost_price_missing",
  });
});
