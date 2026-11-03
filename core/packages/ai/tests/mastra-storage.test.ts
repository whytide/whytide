// The Mastra instance and its storage (README.md "The Mastra instance"), end to end on the LLM fake
// against the worktree's database: the fixture task runs through the instance's agent; Mastra's
// tables and columns, read from information_schema, live in schema `mastra`, none named in the PII
// registry, and no row holds the input. Nothing is fetched on the way.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { it } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, piiKeySuffixes, piiKeys } from "@whytide/platform";
import { getAdapter, isFake, type LlmFake, llmPort } from "@whytide/providers";
import { createMastra, loadAgentTasks, registeredAgentTasks, runAgent } from "../index.ts";
import { mastraOf } from "../mastra/instance.ts";
import { listTaskFiles } from "../registry/generate.ts";

withTestDb(); // the migrations, ai_mastra_schema among them, run before the first test
const fetched: string[] = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  throw new Error("refused: fetch");
};
const llm = await getAdapter(llmPort, "fake");
assert.ok(isFake(llm));
await loadAgentTasks(listTaskFiles(join(import.meta.dirname, "fixtures/registry")));
const task = registeredAgentTasks().get("fixture.assess");
assert.ok(task);

it("runs the fixture task in the instance, whose tables live in schema mastra, free of PII", async () => {
  const instance = await createMastra({ llm });
  const marker = `Ada ${randomUUID()}`;
  try {
    const agent = mastraOf(instance).getAgentById("fixture.assess");
    const generate = agent.generate.bind(agent);
    let calls = 0;
    agent.generate = ((...args: Parameters<typeof generate>) => {
      calls += 1;
      return generate(...args);
    }) as typeof agent.generate;
    (llm as unknown as LlmFake).script({ verdict: "met" });
    const run = await runAgent(task, { profile: marker, evidence: ["Hiring"] });
    assert.deepEqual(run.ok && run.output, { verdict: "met" });
    assert.equal(calls, 1);
  } finally {
    await instance.shutdown();
  }
  // Mastra connected as `app`, which owns its tables: information_schema shows them to `app`.
  const app = asRole("app");
  const tables = await app.$queryRaw<{ table_schema: string; table_name: string }[]>`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_name LIKE 'mastra\_%' ORDER BY table_name`;
  assert.deepEqual([...new Set(tables.map((t) => t.table_schema))], ["mastra"]);
  const names = tables.map((t) => t.table_name);
  for (const name of ["mastra_scorers", "mastra_workflow_snapshot"])
    assert.ok(names.includes(name));
  const columns = await app.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'mastra'`;
  assert.ok(columns.length > 0);
  const pii = columns.filter(({ column_name: column }) => {
    return piiKeys.includes(column) || piiKeySuffixes.some((suffix) => column.endsWith(suffix));
  });
  assert.deepEqual(pii, []);
  for (const name of names) {
    const [row] = await app.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "mastra"."${name}" AS t WHERE t::text LIKE $1`,
      `%${marker}%`,
    );
    assert.equal(row?.n, 0, name);
  }
  assert.deepEqual(fetched, []);
});

it("refuses a call of its agent that brings no model of the port", async () => {
  const instance = await createMastra({ llm });
  try {
    const agent = mastraOf(instance).getAgentById("fixture.assess");
    await assert.rejects(agent.generate("<profile>\nx\n</profile>"), (error: unknown) => {
      const { cause } = error as { cause?: unknown };
      const refusal = isAppError(error) ? error : cause;
      return isAppError(refusal) && refusal.code === "ai_model_id_refused";
    });
  } finally {
    await instance.shutdown();
  }
});
