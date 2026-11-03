// The eraser (domain/erase.ts; core/modules/privacy/README.md "Erasers"), on a schema of the
// worktree's database, rows written by the module's test helpers: the person's messages and threads
// go, every message of their threads with them and their replies' labels by the foreign key's
// cascade, and nobody else's, in the workspace or another.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { erasePerson } from "../domain/erase.ts";
import { createLabel, createMessage, createThread } from "../testing/index.ts";
import { fixture } from "./fixtures.ts";

withTestDb();
const [A, B] = ["wsp_inbox_erase_a", "wsp_inbox_erase_b"];
const [GONE, KEPT] = ["per_inbox_erase_gone", "per_inbox_erase_kept"];
const { run } = fixture(A);

/** A thread of the person with a labeled reply and the account's answer in it: the thread's id. */
async function conversation(workspaceId: string, personId: string): Promise<string> {
  const threadId = await createThread({ workspaceId, personId });
  const messageId = await createMessage({ workspaceId, threadId, personId });
  await createLabel({ workspaceId, messageId, label: "positive", labeledBy: "usr_test" });
  await createMessage({ workspaceId, threadId, personId, direction: "out", body: "Great." });
  return threadId;
}
/** The persons of the workspace's threads, messages and labeled replies, sorted. */
async function rowsOf(workspaceId: string) {
  const where = { workspaceId };
  const threads = await asRole("app").thread.findMany({ where });
  const messages = await asRole("app").message.findMany({ where });
  const labeled = new Set(
    (await asRole("app").replyLabel.findMany({ where })).map(({ messageId }) => messageId),
  );
  return {
    threads: threads.map(({ personId }) => personId).sort(),
    messages: messages.map(({ personId }) => personId).sort(),
    labels: messages.flatMap(({ id, personId }) => (labeled.has(id) ? [personId] : [])).sort(),
  };
}

test("erasePerson deletes the person's messages, threads and labels, and nobody else's", async () => {
  await conversation(A, GONE);
  const second = await conversation(A, GONE);
  await conversation(A, KEPT);
  await conversation(B, GONE);
  // Another person's message in the erased person's thread: it goes with the thread.
  await createMessage({ workspaceId: A, threadId: second, personId: KEPT });

  assert.deepEqual((await rowsOf(A)).labels, [GONE, GONE, KEPT]);

  assert.deepEqual(await run(() => erasePerson(GONE)), { messages: 5, threads: 2 });

  assert.deepEqual(await rowsOf(A), { threads: [KEPT], messages: [KEPT, KEPT], labels: [KEPT] });
  const theirs = { threads: [GONE], messages: [GONE, GONE], labels: [GONE] };
  assert.deepEqual(await rowsOf(B), theirs, "B's rows stay");
  // Again, nothing is left to delete; no id is refused before any delete runs.
  assert.deepEqual(await run(() => erasePerson(GONE)), { messages: 0, threads: 0 });
  await assert.rejects(
    run(() => erasePerson(" ")),
    { code: "person_not_found" },
  );
});
