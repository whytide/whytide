// The signal reader (gamma-p5-030; README.md "Rating"), against the database in the caller's
// tenant run: intentInputs collapses a person's events on a source within the kind's lookback into
// one item with its count; excerpts answers the person's own words, never another's post. Loading
// events.ts and workflows/index.ts, as the worker does from dist/, registers it once.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, newId, servicePrincipal } from "@whytide/platform";
import { defineSignalReader } from "@whytide/qualification";
import { signalReader } from "../domain/reader.ts";
import { ids } from "../ids.ts";
import { createSignalEvent, createSignalSource } from "../testing/index.ts";

withTestDb();
const workspaceId = "wsp_signals_reader";
const principal = servicePrincipal("signals_test");
const inRun = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const NOW = Date.now();
const day = (n: number) => new Date(NOW + n * 86_400_000);
type More = Partial<Parameters<typeof createSignalEvent>[0]>;

test("intentInputs: per person and source, the events within the kind's lookback are one item with their count, showing the author's, else a comment, then the highest relevance, then the newest; a deleted source's events collapse as one source's; older events and other persons' are left out", async () => {
  const post = await createSignalSource({ workspaceId, label: "Launch post" });
  const topic = await asRole("app").signalSource.create({
    data: {
      id: newId(ids.signal_source),
      ...{ workspaceId, kind: "topic_engagement", config: { phrase: "cold outreach" } },
      ...{ label: "Topic", senderAccountId: "sac_test", createdBy: "usr_topic" },
    },
  });
  const event = (personId: string, n: number, more: More = {}) =>
    createSignalEvent({ workspaceId, personId, occurredAt: day(n), ...more });
  const onTopic = { sourceId: topic.id, kind: "topic_engagement" };
  const onPost = { sourceId: post.id };
  // The topic's lookback is 14 days: three within it of the newest, then two more 20 days back.
  await event("per_a", 0, { ...onTopic, rating: { relevance: 0.4, intentClass: null } });
  const pain = { relevance: 0.9, intentClass: "pain_or_complaint" };
  const comment = await event("per_a", -3, { ...onTopic, commentText: "Same pain", rating: pain });
  await event("per_a", -10, onTopic);
  const author = await event("per_a", -20, { ...onTopic, reaction: "author", ownWords: "My post" });
  await event("per_a", -30, { ...onTopic, commentText: "Older" });
  // The post's: reactions only, a repost one of them; the highest relevance shows.
  await event("per_a", -1, { ...onPost, rating: { relevance: 0.2, intentClass: null } });
  const best = await event("per_a", -2, {
    ...onPost,
    rating: { relevance: 0.8, intentClass: null },
  });
  await event("per_a", -5, { ...onPost, reaction: "repost" });
  // A deleted source's: none named; the newest shows when none is rated.
  const orphan = await event("per_a", -2);
  await event("per_a", -4);
  await event("per_a", -100, onTopic);
  const other = await event("per_b", -1, { ...onTopic, commentText: "Interesting" });
  await event("per_c", -1, onTopic);

  const items = await inRun(() =>
    signalReader.intentInputs({ personIds: ["per_a", "per_b"], since: day(-90) }),
  );
  const row = (item: (typeof items)[number]) => [
    ...[item.eventId, item.personId, item.sourceId, item.kind, item.role],
    ...[item.relevance, item.intentClass, item.ownerUserId, item.count],
  ];
  const sorted = [...items].map(row).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const expected = [
    [comment.id, "per_a", topic.id, "topic_engagement", "comment", 0.9, "pain_or_complaint"],
    [author.id, "per_a", topic.id, "topic_engagement", "author", null, null],
    [best.id, "per_a", post.id, "post_engagement", "reaction", 0.8, null],
    [orphan.id, "per_a", "", "post_engagement", "reaction", null, null],
    [other.id, "per_b", topic.id, "topic_engagement", "comment", null, null],
  ];
  const owners = ["usr_topic", "usr_topic", "usr_test", null, "usr_topic"];
  const counts = [3, 2, 3, 2, 1];
  const full = expected.map((values, n) => [...values, owners[n], counts[n]]);
  assert.deepEqual(
    sorted,
    full.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  const shown = items.find((item) => item.eventId === comment.id);
  assert.equal(shown?.occurredAt.getTime(), day(-3).getTime());
  assert.deepEqual(
    await inRun(() => signalReader.intentInputs({ personIds: [], since: day(-90) })),
    [],
  );
});

test("excerpts: up to max of the person's own words not yet reduced, newest first; never the excerpt of the post engaged with", async () => {
  const event = (n: number, more: More) =>
    createSignalEvent({ workspaceId, personId: "per_d", occurredAt: day(n), ...more });
  await event(-5, { commentText: "First comment", postExcerpt: "Someone else's post" });
  await event(-1, { reaction: "author", ownWords: "My own post" });
  await event(-2, { postExcerpt: "Another post" });
  await event(-4, { commentText: "Reduced comment", reducedAt: day(-1) });
  await event(-3, { commentText: "Newer comment" });
  const excerpts = (max: number, personId = "per_d") =>
    inRun(() => signalReader.excerpts({ personId, max }));
  assert.deepEqual(await excerpts(2), ["My own post", "Newer comment"]);
  assert.deepEqual(await excerpts(10), ["My own post", "Newer comment", "First comment"]);
  assert.deepEqual(await excerpts(0), []);
  assert.deepEqual(await excerpts(10, "per_nobody"), []);
});

test("loading events.ts and workflows/index.ts, as the worker does, registers the reader once", async () => {
  await import("../events.ts");
  await import("../workflows/index.ts");
  assert.throws(
    () => defineSignalReader(signalReader),
    (error: unknown) => isAppError(error) && error.code === "signal_reader_duplicate",
  );
});
