// The source country-ai (README "Sources", gamma-en-075) one step at a time on the worktree's
// database and the LLM fake: a sure answer written as the person's country, class ai_inferred,
// provider country-ai; an answer not sure, null, failed twice or with a code contacts does not know
// writes nothing, each its own outcome; a location naming no place asks nothing; a location seen
// before in the workspace is the cached answer, no second model call; the model gets the cleaned
// location text and nothing else of the person; a member's country is never asked for; and no log
// line, sources_tried entry or result carries the location's text.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { loadAgentTasks } from "@whytide/ai";
import { getPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { useLog } from "../domain/log.ts";
import { sourcesTried } from "../domain/readers.ts";
import { prepareRun } from "../domain/runs.ts";
import { loadSources } from "../domain/sources/index.ts";
import { askSource } from "../domain/step.ts";
import { createRun, useAgentCall, useEnrichmentClient, useSourceLists } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
await loadAgentTasks([new URL("../agents/name-country/task.ts", import.meta.url).href]);
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
useAgentCall({ client: asRole("app"), prices });
const WS = "wsp_country_ai";
const SOURCE = "country-ai";
const principal = servicePrincipal("enrichment_test");
const run = <T>(fn: () => Promise<T>, workspaceId = WS) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const runsOf = (workspaceId: string) => ({
  tenant: <T>(fn: () => Promise<T>) => run(fn, workspaceId),
});
let logs = collectLogs();
beforeEach(() => {
  llm.reset();
  useSourceLists({ company: [], person: [SOURCE], companyData: [] });
  logs = collectLogs();
  useLog(createLogger({ destination: logs.destination }));
});
afterEach(() => useLog(undefined));

/** A person with `locationText` and a request's run, prepared; its run's id and the person's. */
async function personRun(slug: string, locationText: string, workspaceId = WS) {
  const profile = {
    linkedinUrl: `https://linkedin.com/in/${slug}`,
    firstName: "Ines",
    locationText,
  };
  const { person } = await run(
    () => upsertPersonFromSource({ source: "linkedin", provider: "unipile", profile }),
    workspaceId,
  );
  const { runId } = await run(
    () => createRun({ personId: person.id, trigger: "request", requestKey: `request:${slug}` }),
    workspaceId,
  );
  const { sources } = await loadSources();
  const plan = await run(() => prepareRun(runId, sources), workspaceId);
  return { runId, personId: person.id, plan };
}
const ask = (runId: string, workspaceId = WS) =>
  askSource(runsOf(workspaceId), { runId, source: SOURCE });
const personOf = (personId: string, workspaceId = WS) =>
  run(() => getPerson(personId), workspaceId);
const tried = async (runId: string, workspaceId = WS) =>
  (await run(() => sourcesTried(runId), workspaceId)).map(({ ms: _ms, ...entry }) => entry);
type Recorded = { messages: { content: { text: string }[] }[] };
const sent = (call = 0) => {
  const { messages } = llm.recordedCalls[call]?.input as Recorded;
  return messages.flatMap((message) => message.content.map((part) => part.text)).join("");
};

test("a sure answer is the person's country, class ai_inferred, provider country-ai; the model gets the cleaned location text only", async () => {
  const { runId, personId, plan } = await personRun("ruhr", "Ruhr Region");
  assert.deepEqual(plan.wanted, ["person.country"]);
  assert.equal((await personOf(personId)).locationCountry, null, "the list could not read it");
  llm.script({ country: "DE", sure: true });
  assert.deepEqual(await ask(runId), {
    outcome: "found",
    filled: ["person.country"],
    inputsAdded: false,
  });
  const person = await personOf(personId);
  assert.equal(person.locationCountry, "DE");
  const { source, provider } = person.fieldProvenance.locationCountry ?? {};
  assert.deepEqual([source, provider], ["ai_inferred", SOURCE]);
  assert.equal(llm.recordedCalls.length, 1);
  assert.equal(sent(), "<location>\nRuhr\n</location>");
  assert.doesNotMatch(JSON.stringify(llm.recordedCalls), /Ines|linkedin|ruhr\b/);
  assert.deepEqual(await tried(runId), [
    { source: SOURCE, outcome: "found", code: null, filled: ["person.country"] },
  ]);
});

test("an answer not sure, null, failed twice or with a code contacts does not know writes nothing, each its own outcome", async () => {
  const answers: [string, unknown[], string][] = [
    ["unsure", [{ country: "GB", sure: false }], "not_sure"],
    ["null", [{ country: null, sure: true }], "not_found"],
    [
      "twice",
      [
        { country: "deu", sure: true },
        { country: "Germany", sure: true },
      ],
      "ai_failed",
    ],
    ["unknown", [{ country: "QQ", sure: true }], "unknown_country"],
  ];
  for (const [slug, scripted, outcome] of answers) {
    llm.reset();
    const { runId, personId } = await personRun(`answer-${slug}`, `Somewhere ${slug} Valley`);
    llm.script(...(scripted as object[]));
    assert.deepEqual(await ask(runId), { outcome, filled: [], inputsAdded: false }, slug);
    assert.equal((await personOf(personId)).locationCountry, null, slug);
    assert.equal(llm.recordedCalls.length, scripted.length, slug);
  }
});

test("'Remote' and 'EMEA, Europe' make no call: no_place; a location seen before in the workspace is the cached answer, no second model call; another workspace asks again", async () => {
  const placeless: [string, string][] = [
    ["remote", "Remote"],
    ["emea", "EMEA, Europe"],
  ];
  for (const [slug, text] of placeless) {
    const { runId } = await personRun(slug, text);
    assert.deepEqual(await ask(runId), { outcome: "no_place", filled: [], inputsAdded: false });
  }
  assert.equal(llm.recordedCalls.length, 0);

  const first = await personRun("seen-1", "Greater Rhine-Neckar Area");
  llm.script({ country: "DE", sure: true });
  assert.equal((await ask(first.runId)).outcome, "found");
  const second = await personRun("seen-2", "Rhine-Neckar");
  assert.equal((await ask(second.runId)).outcome, "found");
  assert.equal((await personOf(second.personId)).locationCountry, "DE");
  assert.equal(llm.recordedCalls.length, 1, "the cache answered the second");

  const other = await personRun("seen-other", "Rhine-Neckar", "wsp_country_ai_other");
  llm.script({ country: "DE", sure: true });
  assert.equal((await ask(other.runId, "wsp_country_ai_other")).outcome, "found");
  assert.equal(llm.recordedCalls.length, 2, "another workspace's call is its own");
});

test("a person whose country a member cleared is not asked for, and one the list read has no run of country-ai; no log line, sources_tried or result carries the location", async () => {
  const cleared = await personRun("member-cleared", "Ruhr Region");
  await run(() =>
    asRole("app").person.update({
      where: { id: cleared.personId },
      data: {
        fieldProvenance: {
          locationCountry: { source: "member", provider: null, at: "2026-11-01T00:00:00.000Z" },
        },
      },
    }),
  );
  const again = await run(() =>
    createRun({ personId: cleared.personId, trigger: "request", requestKey: "request:again" }),
  );
  const { sources } = await loadSources();
  const plan = await run(() => prepareRun(again.runId, sources));
  assert.deepEqual(plan.wanted, []);
  const read = await personRun("list-read", "Boston, MA");
  assert.deepEqual(read.plan.wanted, []);

  const { runId } = await personRun("no-trace", "Secret Hollow Township");
  llm.script({ country: "US", sure: false });
  const result = await ask(runId);
  const traces = JSON.stringify([result, await tried(runId), logs.lines()]);
  assert.doesNotMatch(traces, /Secret|Hollow|Township/);
});
