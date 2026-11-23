// The classifier (gamma-p4-040; README.md "The classifier", docs/flows.md "A reply classified"), on a
// schema of the worktree's database and the LLM fake, as the worker's activity runs it: the model's
// path, its call recorded and campaigns' answer kept; the threshold; the date rule; the gate, asked
// again once, then the fallback; the newest-reply rule, an older reply's opt-out still suppressing;
// the mask and the thread's last messages; a second run writing nothing, and a message gone; the
// label CHECK. The phrase path and the fallbacks are the safety case's
// (tests/safety/classify-opt-out.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { REPLY_ACTION_LABELS } from "@whytide/campaigns";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { upsertUser } from "@whytide/tenancy";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { LATER_LABELS, MS_PER_DAY } from "../domain/classify/constants.ts";
import { createClassification, createMessage } from "../testing/index.ts";
import { answer, classifyFixture, llm } from "./classify-fixtures.ts";
import { HELD } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useTenancyClient(asRole("app"));
const WORKSPACE = "wsp_inbox_classify";
const { app, person, reply, classify, rowOf, stepsOf, leadOf } = classifyFixture(WORKSPACE);
beforeEach(() => llm.reset());
const NOTHING = { actions: [], enrollmentIds: [] };
/** The UTC day `offset` days from now. */
const day = (offset: number) =>
  new Date(Date.now() + offset * MS_PER_DAY).toISOString().slice(0, 10);

type Recorded = { messages: { content: { text: string }[] }[] };
/** A block of a recorded call's user message, parsed as JSON. */
function blockOf(name: string, call = 0): unknown {
  const { messages } = llm.recordedCalls[call]?.input as Recorded;
  const text = messages.flatMap((message) => message.content.map((part) => part.text)).join("");
  return JSON.parse(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1] ?? "null");
}

test("the model's path: an interested answer at 0.9 is stored with its call, not suggested, campaigns' answer kept, and inbox.reply_classified carries ids and the label", async () => {
  const { senderAccountId, personId } = await person("classify-model");
  const ids = await reply(personId, senderAccountId, "Sounds good, can we talk on Tuesday?");
  llm.script(answer("interested", 0.9));

  assert.deepEqual(await classify(ids), { status: "classified", origin: "model", newest: true });

  const row = await rowOf(ids.messageId);
  const records = await app().decisionRecord.findMany({ where: { workspaceId: WORKSPACE } });
  const record = records.find(({ id }) => id === row.decisionRecordId);
  assert.deepEqual(
    [row.label, row.confidence, row.isSuggested, row.optOutDetected, row.origin, row.entities],
    ["interested", 0.9, false, false, "model", { returnDate: null }],
  );
  assert.deepEqual(
    [record?.task, row.modelId, row.promptVersion],
    ["inbox.classify-reply", "fake-model", 1],
  );
  const taken = row.actionsTaken as { actions: string[]; enrollmentIds: string[] };
  assert.deepEqual(
    [taken.actions, taken.enrollmentIds.length],
    [["label_recorded", "notice_published"], 1],
  );
  const events = await app().outboxEntry.findMany({
    where: { workspaceId: WORKSPACE, eventName: "inbox.reply_classified" },
  });
  const payload = { classificationId: row.id, ...ids, label: "interested" };
  assert.ok(events.some((event) => isDeepStrictEqual(event.payload, payload)));
});

test("the threshold: not_interested at 0.6 is stored suggested, and campaigns acts on nothing: the steps stay held", async () => {
  const { senderAccountId, personId } = await person("classify-threshold");
  const ids = await reply(personId, senderAccountId, "Probably not something we need.");
  llm.script(answer("not_interested", 0.6));

  await classify(ids);

  const row = await rowOf(ids.messageId);
  assert.deepEqual(
    [row.label, row.isSuggested, row.actionsTaken],
    ["not_interested", true, NOTHING],
  );
  assert.deepEqual(await stepsOf(personId), HELD);
});

test("the date rule: an out-of-office return date from the reply's day to 90 days after is stored and the pause ends after it; one later, or before the reply, is dropped and the default pause applies", async () => {
  for (const [slug, returnDate, kept] of [
    ["in-range", day(10), day(10)],
    ["too-late", day(120), null],
    ["before", day(-3), null],
  ] as const) {
    const { senderAccountId, personId } = await person(`classify-date-${slug}`, `usr_${slug}`);
    const ids = await reply(personId, senderAccountId, "I am out of the office.");
    llm.script(answer("out_of_office", 0.95, returnDate));

    await classify(ids);

    assert.deepEqual((await rowOf(ids.messageId)).entities, { returnDate: kept }, slug);
    const enrollment = await app().enrollment.findFirstOrThrow({ where: { personId } });
    const { sentAt } = await app().message.findUniqueOrThrow({ where: { id: ids.messageId } });
    const until = enrollment.pausedUntil?.getTime() ?? 0;
    assert.equal(enrollment.status, "paused", slug);
    if (kept === null) assert.equal(until, sentAt.getTime() + 7 * MS_PER_DAY, slug);
    else assert.ok(until > Date.parse(`${kept}T00:00:00Z`), slug);
  }
});

test("the gate: a return date on another label is refused and asked again once, its failure in <validation_error>; refused twice, the fallback with the call's decision record", async () => {
  const { senderAccountId, personId } = await person("classify-gate");
  const ids = await reply(personId, senderAccountId, "Back in touch after the holidays.");
  llm.script(answer("not_now", 0.8, day(20)), answer("not_now", 0.8, day(20)));

  assert.deepEqual(await classify(ids), { status: "classified", origin: "fallback", newest: true });

  assert.equal(llm.recordedCalls.length, 2);
  assert.match(JSON.stringify(llm.recordedCalls[1]), /validation_error.*out_of_office/);
  const row = await rowOf(ids.messageId);
  assert.deepEqual([row.label, row.isSuggested, row.origin], ["other", true, "fallback"]);
  assert.ok(row.decisionRecordId);
});

test("the newest-reply rule: an older reply classified after a newer one is stored and acts on nothing, while an older reply's opt-out still suppresses", async () => {
  const { senderAccountId, personId } = await person("classify-newest");
  const oldest = await reply(personId, senderAccountId, "Not for us, thanks.", { minutesAgo: 60 });
  const older = await reply(personId, senderAccountId, "Never write to me again.", {
    minutesAgo: 30,
  });
  const newest = await reply(personId, senderAccountId, "Actually, let's talk next week.");
  llm.script(answer("interested", 0.9), answer("not_interested", 0.95), answer("opt_out", 0.4));

  assert.deepEqual(await classify(newest), { status: "classified", origin: "model", newest: true });
  assert.deepEqual(await classify(oldest), {
    status: "classified",
    origin: "model",
    newest: false,
  });
  assert.deepEqual((await rowOf(oldest.messageId)).actionsTaken, NOTHING);
  assert.deepEqual(await stepsOf(personId), HELD, "no step cancelled by the older not_interested");
  assert.notEqual(await leadOf(personId), "suppressed");

  assert.deepEqual(await classify(older), { status: "classified", origin: "model", newest: false });
  const opted = { actions: ["opted_out"], enrollmentIds: [] };
  assert.deepEqual((await rowOf(older.messageId)).actionsTaken, opted);
  assert.equal(await leadOf(personId), "suppressed");
});

test("the mask: no name, email address, phone number or link of the reply or its thread reaches the model; the thread's last 6 messages before the reply, oldest first, each with its author and day", async () => {
  const email = `sam-${randomUUID()}@example.test`;
  const owner = await upsertUser({ email, displayName: "Sam Seller" });
  const { senderAccountId, personId } = await person("classify-mask", owner.id);
  const text =
    "Noor here: write to noor.haddad@example.com, call +1 (555) 010-0199 or book https://cal.example/noor today. Thanks Sam!";
  const ids = await reply(personId, senderAccountId, text);
  const sentAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
  for (let index = 1; index <= 8; index += 1) {
    const direction = index % 2 === 1 ? "out" : "in";
    const body = `Line ${index} from Sam Seller, see www.example.com/deck or 030 1234 5678.`;
    const { threadId } = ids;
    await createMessage({
      workspaceId: WORKSPACE,
      threadId,
      personId,
      direction,
      body,
      sentAt: sentAt(10 - index),
    });
  }
  llm.script(answer("interested", 0.9));

  await classify(ids);

  const sent = JSON.stringify(llm.recordedCalls);
  for (const value of [
    "Noor",
    "noor",
    "Sam",
    "Seller",
    "example.com",
    "555",
    "1234",
    "cal.example",
  ]) {
    assert.ok(!sent.includes(value), `${value} reached the model`);
  }
  assert.deepEqual(blockOf("reply"), {
    day: day(0),
    text: "[name] here: write to [email], call [phone] or book [link] today. Thanks [name]!",
  });
  const thread = blockOf("thread") as { from: string; day: string; text: string }[];
  assert.deepEqual(
    thread.map(({ from, text }) => [from, text]),
    [3, 4, 5, 6, 7, 8].map((index) => [
      index % 2 === 1 ? "seller" : "lead",
      `Line ${index} from [name] [name], see [link] or [phone].`,
    ]),
  );
  assert.ok(thread.every((message) => message.day === day(0)));
});

test("a second run on the same reply writes no second row, calls no model and acts no second time; a message no longer stored is gone", async () => {
  const { senderAccountId, personId } = await person("classify-repeat");
  const ids = await reply(personId, senderAccountId, "Interesting, tell me more.");
  llm.script(answer("interested", 0.9));
  await classify(ids);
  const eventsOf = () => app().outboxEntry.count({ where: { workspaceId: WORKSPACE } });
  const before = await eventsOf();

  assert.deepEqual(await classify(ids), { status: "repeat" });

  assert.equal(llm.recordedCalls.length, 1, "no second model call");
  const where = { messageId: ids.messageId };
  assert.equal(await app().replyClassification.count({ where }), 1);
  assert.equal(await eventsOf(), before, "no second event, no second notice");
  assert.deepEqual(await classify({ ...ids, messageId: "msg_gone" }), { status: "gone" });
});

test("the label CHECK takes the 7 labels and the 15 of RB-13.2.1, 20 values; it refuses another label, a confidence outside 0 to 1, another origin and a model's row without its call", async () => {
  const { senderAccountId, personId } = await person("classify-check");
  const row = { workspaceId: WORKSPACE, ...(await reply(personId, senderAccountId, "Hello.")) };
  const labels = new Set<string>([...REPLY_ACTION_LABELS, ...LATER_LABELS]);
  assert.equal(labels.size, 20);
  for (const label of labels) {
    const id = await createClassification({ ...row, label });
    await app().replyClassification.delete({ where: { id } });
  }
  const refused = /reply_classifications_values/;
  await assert.rejects(createClassification({ ...row, label: "maybe" }), refused);
  await assert.rejects(createClassification({ ...row, label: "other", confidence: 1.5 }), refused);
  const origin = "user" as "model";
  await assert.rejects(createClassification({ ...row, label: "other", origin }), refused);
  const id = await createClassification({ ...row, label: "other" });
  const unnamed = `UPDATE reply_classifications SET decision_record_id = NULL WHERE id = '${id}'`;
  await assert.rejects(app().$executeRawUnsafe(unnamed), refused);
});
