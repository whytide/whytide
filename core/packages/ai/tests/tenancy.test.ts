// test:tenancy for decision_records and grounding_samples (docs/rules/security.md §3;
// core/packages/db README "Register a tenant table in the isolation test"): callAgent writes a
// record of one key in each workspace, and a reading of one week is written in each; a read without
// workspace_id, scoped by the tenant client alone, finds its own workspace's only. rawPrompts and
// eraseDecisionRecords go through the tenant client of the caller's run; the erasure deletes the
// subject's records and no one else's.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { inputHash } from "../call/hash.ts";
import {
  type AgentTask,
  aiIds,
  callAgent,
  eraseDecisionRecords,
  loadAgentTasks,
  rawPrompts,
  registeredAgentTasks,
} from "../index.ts";
import { listTaskFiles } from "../registry/generate.ts";

withTestDb();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
await loadAgentTasks(listTaskFiles(join(import.meta.dirname, "fixtures/registry")));
const task = registeredAgentTasks().get("fixture.assess") as AgentTask;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const input = { profile: "CTO", evidence: ["Hiring"] };
const key = {
  task: task.name,
  subjectRef: "per_a",
  inputHash: inputHash(input),
  modelId: "fake-model",
};

isolationTest("decision_records", {
  async createRow(workspaceId) {
    fake.script({ verdict: "met" });
    const call = { workspaceId, subjectRef: key.subjectRef, input };
    const result = await callAgent(task, call, { client: asRole("app"), prices });
    return { id: result.decisionRecordId };
  },
  async readAs(workspaceId) {
    const tenant = { workspaceId, principal: servicePrincipal("test") };
    const where = { ...key, promptVersion: task.promptVersion };
    return withTenant(tenant, (tx) => tx.decisionRecord.findMany({ where }), {
      client: asRole("app"),
    });
  },
});

const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("test") }, fn, { client: asRole("app") });
isolationTest("grounding_samples", {
  async createRow(workspaceId) {
    const id = newId(aiIds.grounding_sample);
    const counts = { whyCount: 20, draftCount: 20, inventedFacts: 0, reviewedBy: "usr_a" };
    const data = { id, workspaceId, week: "2026-W43", ...counts };
    await inRun(workspaceId, (tx) => tx.groundingSample.create({ data }));
    return { id };
  },
  readAs: (workspaceId) =>
    inRun(workspaceId, (tx) => tx.groundingSample.findMany({ where: { week: "2026-W43" } })),
});

test("rawPrompts goes through the tenant client of the caller's run", async () => {
  await assertScoped(() => rawPrompts(["dec_0"]));
});

test("eraseDecisionRecords deletes the subject's records in the caller's run, and no one else's", async () => {
  const workspaceId = "wsp_erasure";
  const calls = [
    ["per_erased", ["Hiring"]],
    ["per_erased", ["Funding"]],
    ["per_kept", ["Hiring"]],
  ] as const;
  for (const [subjectRef, evidence] of calls) {
    fake.script({ verdict: "met" });
    const call = { workspaceId, subjectRef, input: { profile: "CTO", evidence: [...evidence] } };
    await callAgent(task, call, { client: asRole("app"), prices });
  }
  const tenant = { workspaceId, principal: servicePrincipal("test") };
  const erase = (subjectRef: string) =>
    withTenant(tenant, () => eraseDecisionRecords(subjectRef), { client: asRole("app") });
  assert.deepEqual(await erase("per_erased"), { decision_records: 2 });
  const left = await asRole("app").decisionRecord.findMany({ where: { workspaceId } });
  assert.deepEqual(
    left.map((record) => record.subjectRef),
    ["per_kept"],
  );
  await assert.rejects(erase(""), {
    code: "ai_input_invalid",
    details: { fields: ["subjectRef"] },
  });
  await assertScoped(() => eraseDecisionRecords("per_none"));
});
