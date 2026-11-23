// The safety case of the store's run (beta-p5-010; README.md "The store"; F12 §11 "Any reply stops
// the sequence for that person"), on a schema of the worktree's database, in tenant runs as the
// worker's activity has them: the message, the hold and the opt-out commit together, and a failure
// after the hold, at the message's insert or at the commit, leaves none of them, the lead still in
// its campaign. No model in the path (AGENTS.md rule 5, as gamma-p4-040 rewrote it): none of
// inbox's own files that the store's run imports names @whytide/ai or reaches the classifier, no
// file but the classifier's imports @whytide/ai in any form, and a stored reply calls no model.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

/** What a source imports: from "…", a bare import "…" and import("…"); never import.meta. */
const FROM = /\b(?:from|import)\s*\(?\s*"([^"]+)"/g;
const specifiersOf = (text: string) => [...text.matchAll(FROM)].map(([, name = ""]) => name);
const isAi = (name: string) => /^@whytide\/ai(?:\/|$)/.test(name);
type Read = (url: URL) => Promise<string>;
const fromDisk: Read = (url) => readFile(url, "utf8");

/** Each inbox file the entry reaches by its relative imports, with the packages it imports. */
async function reachable(entry: URL, read: Read): Promise<Map<string, string[]>> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  for (let url = queue.pop(); url !== undefined; url = queue.pop()) {
    if (seen.has(url.pathname)) continue;
    const specifiers = specifiersOf(await read(url));
    const packages = specifiers.filter((s) => !s.startsWith("."));
    seen.set(url.pathname, packages);
    queue.push(...specifiers.filter((s) => s.startsWith(".")).map((s) => new URL(s, url)));
  }
  return seen;
}

/** The classifier's files, by their path from the module's root; its constants import nothing. */
const CLASSIFIER = /^(?:agents\/|domain\/classify\/(?!constants\.ts$))/;

// Rule 5's breaches under root, each file by its path from it: the store's run naming
// @whytide/ai or reaching the classifier, and a file but the classifier's importing it.
async function breaches(root: URL, files: readonly string[], read = fromDisk): Promise<string[]> {
  const found: string[] = [];
  for (const [path, packages] of await reachable(new URL("domain/store/store.ts", root), read)) {
    const file = path.slice(root.pathname.length);
    if (packages.some(isAi)) found.push(`the store's run: ${file} names ai`);
    if (CLASSIFIER.test(file)) found.push(`the store's run reaches ${file}`);
  }
  for (const file of files) {
    const named = specifiersOf(await read(new URL(file, root))).some(isAi);
    if (named && !/^(?:agents|domain\/classify)\//.test(file)) found.push(`${file} names ai`);
  }
  return found;
}

/** The folders the module's sources are not in, at its root. */
const SKIPPED = new Set(["node_modules", "dist", "tests", ".tmp"]);
/** The module's .ts and .tsx files, by their path from the root; links are not followed. */
async function sources(root: URL, folder = ""): Promise<string[]> {
  const entries = await readdir(new URL(folder, root), { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = `${folder}${entry.name}`;
      if (entry.isDirectory()) return SKIPPED.has(path) ? [] : sources(root, `${path}/`);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return found.flat();
}

test("no model in the stop: none of inbox's files the store's run imports names @whytide/ai or reaches the classifier, no file but the classifier's imports @whytide/ai in any form (a planted bare and dynamic import caught), and a stored reply calls no model", async () => {
  const root = new URL("../../", import.meta.url);
  const files = await sources(root);
  const classify = await fromDisk(new URL("domain/classify/classify.ts", root));
  assert.ok(specifiersOf(classify).some(isAi), "the classifier's import is read");
  assert.ok(files.includes("domain/classify/classify.ts"), "the walk finds the classifier");
  assert.deepEqual(await breaches(root, files), []);
  // The control, in memory: a bare and two dynamic imports, each caught; import.meta names nothing.
  const planted = new Map([
    ["domain/store/store.ts", 'import "@whytide/ai";\nawait import("../classify/classify.ts");'],
    ["ui/x.ts", 'const ai = await import("@whytide/ai");\nimport.meta.url;'],
  ]);
  const at = new URL("file:///planted/");
  const read: Read = async (url) => planted.get(url.pathname.slice(at.pathname.length)) ?? "";
  assert.deepEqual(await breaches(at, [...planted.keys()], read), [
    "the store's run: domain/store/store.ts names ai",
    "the store's run reaches domain/classify/classify.ts",
    "domain/store/store.ts names ai",
    "ui/x.ts names ai",
  ]);
  const { id: senderAccountId } = await account();
  const personId = await enrolled(senderAccountId, "reply-hold-no-model");
  llm.reset();

  await store(personId, senderAccountId, replyFile("Thanks, next week works."));

  assert.deepEqual(await stepsOf(personId), HELD);
  assert.equal(llm.recordedCalls.length, 0);
});
