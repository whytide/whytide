// purgeRawRecords end to end (README.md "Decision records", docs/runbook.md): the records whose
// raw_purge_after has come lose their raw prompt and output, in every workspace; the others keep them,
// and nothing else of a record changes.
import assert from "node:assert/strict";
import { it } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { purgeRawRecords } from "../index.ts";

withTestDb();
const now = new Date("2026-10-22T03:00:00.000Z");
const day = 86_400_000;
const rawPrompt = "<profile>\nCTO\n</profile>";
const rawOutput = '{"verdict":"met"}';
const record = (id: string, workspaceId: string, rawPurgeAfter: number) => ({
  id,
  workspaceId,
  task: "fixture.assess",
  subjectRef: "per_a",
  inputHash: id,
  modelId: "fake-model",
  promptVersion: 1,
  status: "ok" as const,
  output: { verdict: "met" },
  gates: [],
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
  costCredits: 0,
  attempts: 1,
  rawPrompt,
  rawOutput,
  rawPurgeAfter: new Date(rawPurgeAfter),
  createdAt: new Date(rawPurgeAfter - 30 * day),
});

it("nulls the raw prompt and output past raw_purge_after in every workspace, and nothing else", async () => {
  const app = asRole("app");
  const data = [
    record("dec_past", "wsp_a", now.getTime() - day),
    record("dec_due", "wsp_b", now.getTime()),
    record("dec_kept", "wsp_a", now.getTime() + day),
  ];
  await app.decisionRecord.createMany({ data });
  assert.equal(await purgeRawRecords({ client: app, now }), 2);
  const rows = await app.decisionRecord.findMany({ orderBy: { id: "asc" } });
  assert.deepEqual(
    rows.map((row) => [row.id, row.rawPrompt, row.rawOutput, row.output, row.status]),
    [
      ["dec_due", null, null, { verdict: "met" }, "ok"],
      ["dec_kept", rawPrompt, rawOutput, { verdict: "met" }, "ok"],
      ["dec_past", null, null, { verdict: "met" }, "ok"],
    ],
  );
  assert.equal(await purgeRawRecords({ client: app, now }), 0);
});
