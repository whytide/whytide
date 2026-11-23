// The rating's pure parts (gamma-p5-030; README.md "Rating"): the scrub, the batch input, and the
// validation of the answer, its schema and its gate; the classes are qualification's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTENT_CLASSES } from "@whytide/qualification";
import { ratingsGate } from "../domain/rate/checks.ts";
import { batchOf, type RatedEvent } from "../domain/rate/rate.ts";
import { scrub } from "../domain/rate/scrub.ts";
import {
  RATE_CLASSES,
  rateEngagementInput,
  rateEngagementOutput,
} from "../schemas/rate-engagement.ts";

const offer = {
  oneLiner: "Pipeline analytics for RevOps",
  products: ["Forecasts"],
  painPoints: [],
};
const event = (more: Partial<RatedEvent>): RatedEvent => ({
  ...{ id: "sev_1", personId: "per_1", kind: "topic_engagement", excerpt: null, postExcerpt: null },
  ...{ reaction: "like", author: "Dana Okafor", ...more },
});

test("the scrub turns links, emails, phone numbers and the engager's name into placeholders", () => {
  const text =
    "Dana here: see https://acme.example/p?x=1 or acme.io, mail dana.o@acme.example, call +44 20 7946 0958. 10-12 reps, Q3 2026; we will try.";
  assert.equal(
    scrub(text, "Dana Okafor"),
    "[name] here: see [link] or [link], mail [email], call [phone]. 10-12 reps, Q3 2026; we will try.",
  );
  assert.equal(scrub("Thanks, Okafor-Smith!", "Dana Okafor-Smith"), "Thanks, [name]!");
  assert.equal(scrub("Will it scale? we will see", "Will Ng"), "[name] it scale? we will see");
  assert.equal(scrub(null, "Dana Okafor"), null);
});

test("the batch: events with words or a post, indexed from 1, a like and a repost reactions, texts scrubbed, never a name, URL or headline", () => {
  const batch = batchOf(offer, [
    event({
      id: "sev_a",
      reaction: "comment",
      excerpt: "Dana: we need forecasts",
      postExcerpt: "Q?",
    }),
    event({ id: "sev_b", reaction: "like" }),
    event({ id: "sev_c", personId: "per_2", reaction: "repost", postExcerpt: "See dana@x.io" }),
    event({ id: "sev_d", kind: "my_post_engagement", reaction: "author", excerpt: "Our launch" }),
  ]);
  assert.ok(batch !== null);
  assert.deepEqual(batch.input, {
    offer,
    events: [
      {
        index: 1,
        kind: "topic_engagement",
        role: "comment",
        words: "[name]: we need forecasts",
        post: "Q?",
      },
      { index: 2, kind: "topic_engagement", role: "reaction", words: null, post: "See [email]" },
      { index: 3, kind: "my_post_engagement", role: "author", words: "Our launch", post: null },
    ],
  });
  assert.deepEqual(
    [...batch.named],
    [
      [1, { eventId: "sev_a", personId: "per_1" }],
      [2, { eventId: "sev_c", personId: "per_2" }],
      [3, { eventId: "sev_d", personId: "per_1" }],
    ],
  );
  assert.ok(rateEngagementInput.safeParse(batch.input).success);
  assert.doesNotMatch(JSON.stringify(batch.input), /Okafor|Dana|sev_|per_/);
  assert.equal(batchOf(offer, [event({ reaction: "like" })]), null);
});

test("the answer: its schema bounds relevance, the rationale and the class; the gate wants each event once, no other index, and a class exactly when there are words", () => {
  const input = {
    offer,
    events: [
      {
        index: 1,
        kind: "topic_engagement",
        role: "comment" as const,
        words: "Need it",
        post: null,
      },
      {
        index: 2,
        kind: "topic_engagement",
        role: "reaction" as const,
        words: null,
        post: "A post",
      },
    ],
  };
  const rating = (index: number, intentClass: (typeof RATE_CLASSES)[number] | null) => ({
    ...{ index, relevance: 0.8, rationale: "Asks for forecasts.", intentClass },
  });
  const ok = { ratings: [rating(1, "seeking_recommendation"), rating(2, null)] };
  assert.ok(rateEngagementOutput.safeParse(ok).success);
  assert.deepEqual(ratingsGate(ok, input), { gate: "ratings", issues: [] });
  const off = [
    { ratings: [{ ...rating(1, "other"), relevance: 1.2 }] },
    { ratings: [{ ...rating(1, "other"), rationale: "x".repeat(201) }] },
    { ratings: [{ ...rating(1, "other"), intentClass: "curious" }] },
    { ratings: [{ ...rating(1, "other"), index: 11 }] },
  ];
  for (const answer of off) assert.equal(rateEngagementOutput.safeParse(answer).success, false);
  const messages = (ratings: ReturnType<typeof rating>[]) =>
    ratingsGate({ ratings }, input).issues.map(({ message }) => message);
  assert.deepEqual(messages([rating(1, "other")]), ["event 2: 0 ratings, one expected"]);
  assert.deepEqual(messages([rating(1, "other"), rating(1, "other"), rating(2, null)]), [
    "event 1: 2 ratings, one expected",
  ]);
  assert.deepEqual(messages([rating(1, null), rating(2, "other")]), [
    "event 1: a class expected",
    "event 2: no words, so no class",
  ]);
  assert.deepEqual(messages([rating(1, "other"), rating(2, null), rating(3, null)]), [
    "event 3: not in the input",
  ]);
});

test("the classes are qualification's, in its order", () => {
  assert.deepEqual([...RATE_CLASSES], [...INTENT_CLASSES]);
});
