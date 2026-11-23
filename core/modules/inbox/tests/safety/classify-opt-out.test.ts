// The classifier's safety case (gamma-p4-040; README.md "The classifier"; F12 R2, RB-13.2.2): an
// opt-out suppresses at any confidence and is never lifted, and the stop never waits for the model.
// On a schema of the worktree's database, in tenant runs as the worker's activity has them, on the
// LLM fake: a phrase the store matched is opt_out with no model call; a hostile reply, or the model's
// opt_out at confidence 0.3, suppresses the person on every channel; an interested answer on a newer
// reply leaves them suppressed; the store's run holds the steps before any model call, and a
// classifier whose model fails, or whose activity fails past its attempts, leaves them held.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { answer, classifyFixture, llm } from "../classify-fixtures.ts";
import { HELD } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useTenancyClient(asRole("app"));
const WORKSPACE = "wsp_inbox_classify_safety";
const { app, person, reply, classify, fallBack, rowOf, optOutChannels, stepsOf, leadOf } =
  classifyFixture(WORKSPACE);
beforeEach(() => llm.reset());

test("a reply the store matched as an opt-out is opt_out, origin phrase, confidence 1, and no model is called", async () => {
  const { senderAccountId, personId } = await person("classify-safety-phrase");
  const ids = await reply(personId, senderAccountId, "Thanks, but please remove me from this.");
  assert.equal(await leadOf(personId), "suppressed", "the store's run suppressed first");

  assert.deepEqual(await classify(ids), { status: "classified", origin: "phrase", newest: true });

  const row = await rowOf(ids.messageId);
  assert.deepEqual(
    [row.label, row.origin, row.confidence, row.isSuggested, row.optOutDetected],
    ["opt_out", "phrase", 1, false, true],
  );
  assert.equal(row.decisionRecordId, null);
  assert.equal(llm.recordedCalls.length, 0, "no model call");
  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"]);
});

for (const [slug, name, text, confidence, suggested] of [
  [
    "low",
    "the model's opt_out at confidence 0.3",
    "Who gave you my details? I never agreed.",
    0.3,
    true,
  ],
  [
    "hostile",
    "a hostile reply",
    "This is spam, I will report your account. Leave me alone.",
    0.95,
    false,
  ],
] as const) {
  test(`${name}, no phrase matched, suppresses the person on every channel`, async () => {
    const { senderAccountId, personId } = await person(`classify-safety-${slug}`);
    const ids = await reply(personId, senderAccountId, text);
    assert.notEqual(await leadOf(personId), "suppressed", "no phrase matched at the store");
    assert.deepEqual(await optOutChannels(), []);
    llm.script(answer("opt_out", confidence));

    assert.deepEqual(await classify(ids), { status: "classified", origin: "model", newest: true });

    const row = await rowOf(ids.messageId);
    assert.deepEqual(
      [row.label, row.origin, row.isSuggested, row.optOutDetected],
      ["opt_out", "model", suggested, true],
    );
    assert.ok((row.actionsTaken as { actions: string[] }).actions.includes("opted_out"));
    assert.equal(await leadOf(personId), "suppressed");
    assert.deepEqual(await optOutChannels(), ["all"], "one opt-out, on every channel");
  });
}

test("no later label lifts an opt-out: an interested answer on a newer reply leaves the person suppressed", async () => {
  const { senderAccountId, personId } = await person("classify-safety-lift");
  await classify(await reply(personId, senderAccountId, "Remove me.", { minutesAgo: 10 }));
  const later = await reply(personId, senderAccountId, "On second thought, tell me more.");
  llm.script(answer("interested", 0.95));

  assert.deepEqual(await classify(later), { status: "classified", origin: "model", newest: true });

  const row = await rowOf(later.messageId);
  assert.deepEqual([row.label, row.isSuggested, row.optOutDetected], ["interested", false, false]);
  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"], "the opt-out stands");
});

test("the stop does not wait for the classifier: the store's run holds the steps with no model call, and a model failing every answer leaves them held, the reply other, suggested, fallback", async () => {
  const { senderAccountId, personId } = await person("classify-safety-failing");
  const ids = await reply(personId, senderAccountId, "Thanks, next week works for a call.");
  assert.deepEqual(await stepsOf(personId), HELD);
  assert.equal(llm.recordedCalls.length, 0, "no model in the store's run");
  llm.script("not an answer", "still not an answer");

  assert.deepEqual(await classify(ids), { status: "classified", origin: "fallback", newest: true });

  const row = await rowOf(ids.messageId);
  assert.deepEqual(
    [row.label, row.isSuggested, row.origin, row.optOutDetected],
    ["other", true, "fallback", false],
  );
  assert.ok(row.decisionRecordId, "the failed call's decision record");
  assert.deepEqual(row.actionsTaken, { actions: [], enrollmentIds: [] });
  assert.deepEqual(await stepsOf(personId), HELD);
});

test("a provider failing the call: the activity fails with the port's code and writes nothing, and the fallback past its attempts stores other, suggested, the steps held", async () => {
  const { senderAccountId, personId } = await person("classify-safety-provider");
  const ids = await reply(personId, senderAccountId, "Thanks, next week works for a call.");
  llm.failNext("llm_provider_error");

  await assert.rejects(classify(ids), { code: "llm_provider_error" });
  assert.equal(await app().replyClassification.count({ where: { workspaceId: WORKSPACE } }), 0);

  assert.deepEqual(await fallBack(ids), { status: "classified", origin: "fallback", newest: true });
  const row = await rowOf(ids.messageId);
  assert.deepEqual(
    [row.label, row.isSuggested, row.origin, row.decisionRecordId],
    ["other", true, "fallback", null],
  );
  assert.deepEqual(await stepsOf(personId), HELD);
});

test("past the attempts on a phrase-matched reply, the fallback still stores the phrase's opt_out", async () => {
  const { senderAccountId, personId } = await person("classify-safety-fallback-phrase");
  const ids = await reply(personId, senderAccountId, "Please unsubscribe me.");

  assert.deepEqual(await fallBack(ids), { status: "classified", origin: "phrase", newest: true });
  const row = await rowOf(ids.messageId);
  assert.deepEqual([row.label, row.origin, row.optOutDetected], ["opt_out", "phrase", true]);
  assert.equal(await leadOf(personId), "suppressed");
});
