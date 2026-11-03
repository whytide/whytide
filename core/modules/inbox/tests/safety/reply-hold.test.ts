// The safety case of the store's run (beta-p5-010; README.md "The store"; F12 §11 "Any reply stops
// the sequence for that person"), on a schema of the worktree's database, in tenant runs as the
// worker's activity has them: the message, the hold and the opt-out commit together, and a failure
// after the hold, at the message's insert or at the commit, leaves none of them, the lead still in
// its campaign. No model in the path: no @whytide/ai dependency, no call to the LLM port.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import type { MessageFile } from "@whytide/linkedin";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import { storeInbound } from "../../domain/store/store.ts";
import { failing, fixture, HELD, PENDING, replyFile } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const { run, enrolled, account, stepsOf, leadOf, optOuts, eventNames, threads, messages } =
  fixture("wsp_inbox_reply_hold");
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;

const store = (personId: string, senderAccountId: string, file: MessageFile | null) =>
  run(() => storeInbound({ personId, senderAccountId, file, now: new Date() }));
/** What a store writes, in the workspace, to compare before and after. */
const written = async () => ({
  threads: await threads(),
  messages: await messages(),
  optOuts: await optOuts(),
  events: await eventNames(),
});

test("the store's run commits the message, the hold and the opt-out together", async () => {
  const { id: senderAccountId } = await account();
  const personId = await enrolled(senderAccountId, "reply-hold-together");
  const before = await written();

  const { messageId, ...flags } = await store(personId, senderAccountId, replyFile("Remove me."));

  assert.deepEqual(flags, { stored: true, held: true, optOut: true });
  assert.deepEqual(await stepsOf(personId), HELD);
  const after = await written();
  const message = after.messages.find(({ id }) => id === messageId);
  assert.equal(message?.optOutMatched, true);
  assert.equal(after.threads.length, before.threads.length + 1);
  assert.deepEqual(after.optOuts.slice(before.optOuts.length), [["system", "reply_opt_out"]]);
  assert.equal(await leadOf(personId), "suppressed", "the opt-out outranks the reply");
  const published = after.events.slice(before.events.length);
  assert.equal(published.filter((name) => name === "inbox.reply_received").length, 1);
});

for (const [at, table, when] of [
  ["the message's insert", "messages", "insert"],
  ["the commit", "outbox", "commit"],
] as const) {
  test(`a failure after the hold, at ${at}, leaves no message, no held step and no opt-out`, async () => {
    const { id: senderAccountId } = await account();
    const personId = await enrolled(senderAccountId, `reply-hold-${when}`);
    const before = await written();

    await failing(table, when, async () => {
      const file = replyFile("Stop. Remove me from this.");
      await assert.rejects(store(personId, senderAccountId, file), /the store fails/);
    });

    assert.deepEqual(await stepsOf(personId), PENDING, "no step held");
    assert.equal(await leadOf(personId), "in_campaign");
    assert.deepEqual(await written(), before, "no thread, message, opt-out or event");
  });
}

test("no model in the stop: no @whytide/ai dependency and no call to the LLM port", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  assert.equal("@whytide/ai" in declared, false);
  const { id: senderAccountId } = await account();
  const personId = await enrolled(senderAccountId, "reply-hold-no-model");
  llm.reset();

  await store(personId, senderAccountId, replyFile("Thanks, next week works."));

  assert.deepEqual(await stepsOf(personId), HELD);
  assert.equal(llm.recordedCalls.length, 0);
});
