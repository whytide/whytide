// The thread owner's label's safety case (gamma-p4-055; README.md "API", "The classifier"; F12 §5,
// RB-13.2.2): a label the classifier only suggested acts on nothing until the thread's owner
// confirms it, then once, a notice or an out-of-office's release of the hold; the owner's opt_out
// suppresses the person on every channel in the label's own run, and no label lifts an opt-out, the
// owner's or the classifier's; a model's opt_out after the owner's label still suppresses. On a
// schema of the worktree's database, in tenant runs as the route and the worker's activity have
// them, on the LLM fake.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ReplyActionLabel } from "@whytide/campaigns";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { MS_PER_DAY } from "../../domain/classify/constants.ts";
import { setLabel } from "../../domain/labels/label.ts";
import { answer, classifyFixture, llm } from "../classify-fixtures.ts";
import { HELD, OWNER } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useTenancyClient(asRole("app"));
const WORKSPACE = "wsp_inbox_confirm_safety";
const { app, run, person, reply, classify, rowOf, optOutChannels, stepsOf, leadOf } =
  classifyFixture(WORKSPACE);
beforeEach(() => llm.reset());

/** The thread owner's label, as the route sets it in the request's tenant run. */
const label = (messageId: string, value: ReplyActionLabel) =>
  run(() => setLabel(messageId, value, OWNER));
/** The notices campaigns published: one mail to the owner each. */
const notices = () =>
  app().outboxEntry.count({
    where: { workspaceId: WORKSPACE, eventName: "campaigns.reply_notice_due" },
  });
const enrollmentOf = (personId: string) =>
  app().enrollment.findFirstOrThrow({ where: { personId } });
/** The UTC day `offset` days from now. */
const day = (offset: number) =>
  new Date(Date.now() + offset * MS_PER_DAY).toISOString().slice(0, 10);

test("a suggested interested sends no notice until the thread's owner confirms it, then exactly one; confirming again sends none", async () => {
  const { senderAccountId, personId } = await person("confirm-safety-interested");
  const ids = await reply(personId, senderAccountId, "Maybe. What would it cost us?");
  llm.script(answer("interested", 0.55));
  await classify(ids);
  assert.equal((await rowOf(ids.messageId)).isSuggested, true);
  assert.equal(await notices(), 0, "a suggestion sends no notice");
  assert.deepEqual(await stepsOf(personId), HELD);

  const confirmed = await label(ids.messageId, "interested");

  assert.deepEqual(
    [confirmed.label, confirmed.classLabel, confirmed.labeledBy],
    ["positive", "interested", OWNER],
  );
  assert.equal(await notices(), 1, "confirmed: one notice");
  await label(ids.messageId, "interested");
  assert.equal(await notices(), 1, "the same label again: no second notice");
});

test("a suggested out_of_office keeps the hold until the owner confirms it, then releases it and pauses until after the classification's return date", async () => {
  const { senderAccountId, personId } = await person("confirm-safety-ooo");
  const ids = await reply(personId, senderAccountId, "I am away, back in ten days.");
  llm.script(answer("out_of_office", 0.5, day(10)));
  await classify(ids);
  assert.deepEqual(await stepsOf(personId), HELD, "a suggestion releases nothing");
  assert.equal((await enrollmentOf(personId)).status, "replied");

  await label(ids.messageId, "out_of_office");

  const enrollment = await enrollmentOf(personId);
  assert.deepEqual([enrollment.status, enrollment.pausedReason], ["paused", "out_of_office"]);
  const until = enrollment.pausedUntil?.getTime() ?? 0;
  assert.ok(until > Date.parse(`${day(10)}T00:00:00Z`), "after the return date");
});

test("the owner's opt_out suppresses the person on every channel in the label's run and cancels the held steps; moving the label away leaves them suppressed", async () => {
  const { senderAccountId, personId } = await person("confirm-safety-opt-out");
  const ids = await reply(personId, senderAccountId, "Not the right time for us.");
  llm.script(answer("not_now", 0.5));
  await classify(ids);
  assert.deepEqual(await optOutChannels(), []);

  const chosen = await label(ids.messageId, "opt_out");

  assert.deepEqual([chosen.label, chosen.classLabel], ["not_positive", "opt_out"]);
  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"], "one opt-out, on every channel");
  const pending = (await stepsOf(personId)).slice(1);
  assert.ok(
    pending.every(([, status, reason]) => status === "cancelled" && reason === "opted_out"),
  );
  for (const away of ["interested", "not_now", "other"] as const) {
    const moved = await label(ids.messageId, away);
    assert.equal(moved.classLabel, away);
    assert.equal(await leadOf(personId), "suppressed", away);
    assert.deepEqual(await optOutChannels(), ["all"], away);
  }
  assert.equal(await notices(), 0, "nothing acts for the suppressed person");
});

test("the classifier's opt_out the owner moves away from leaves the person suppressed", async () => {
  const { senderAccountId, personId } = await person("confirm-safety-model-opt-out");
  const ids = await reply(personId, senderAccountId, "Who gave you my details?");
  llm.script(answer("opt_out", 0.3));
  await classify(ids);
  assert.equal(await leadOf(personId), "suppressed", "the model's opt_out at 0.3 suppressed");

  await label(ids.messageId, "interested");

  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"]);
});

test("a model's opt_out after the owner's label still suppresses: when in doubt, suppress", async () => {
  const { senderAccountId, personId } = await person("confirm-safety-model-after");
  const ids = await reply(personId, senderAccountId, "I never agreed to any of this.");
  await label(ids.messageId, "interested");
  llm.script(answer("opt_out", 0.4));

  await classify(ids);

  const row = await rowOf(ids.messageId);
  assert.deepEqual([row.label, row.isSuggested, row.optOutDetected], ["opt_out", true, true]);
  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"]);
});
