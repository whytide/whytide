// The reply golden set's pure parts (beta-p7-030; README.md "The reply golden set"): a line's hashes,
// label and texts; its channel, the owner's class, the classification and the phrases' match
// (gamma-p7-060); `earlier`, the thread's messages before the reply, oldest first, the latest ten;
// the person's names masked in every text; the ISO week's instants and its refusals. No database.
// Made-up names only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { EXPORT_EARLIER_MAX } from "../domain/export/constants.ts";
import {
  maskNames,
  type PersonNames,
  replyLine,
  type ThreadText,
} from "../domain/export/reply-line.ts";
import { weekRange } from "../domain/export/week.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-27T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * MINUTE);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const NAMES: PersonNames = { firstName: "Ottoline", lastName: "Vashti" };
const THREAD = {
  personId: "per_1",
  threadId: "thr_1",
  channel: "linkedin",
  names: NAMES,
  classification: null,
} as const;
/** A message of the thread, `msg_<tag>`: the campaign's when `out`, the person's when `in`. */
const message = (tag: string, minutes: number, direction: "in" | "out" = "out"): ThreadText => ({
  id: `msg_${tag}`,
  direction,
  sentBy: direction === "out" ? "campaign" : null,
  body: `${tag}: hi Ottoline`,
  sentAt: at(minutes),
});
/** The tag a text starts with. */
const tagOf = (text: string) => text.split(":")[0];
const LABEL = { label: "not_positive", classLabel: "not_now", labeledAt: at(60) } as const;
const weekInvalid = (error: unknown) => isAppError(error) && error.code === "week_invalid";

test("a line: the sha256 of the person's and the thread's ids, the channel, the label, the owner's class and its time, the reply's time and text, the phrases' match, the classification, the messages before it; no id, no name", () => {
  const reply = {
    ...{ ...message("03", 30, "in"), body: "Yes Ottoline here" },
    ...{ receivedAt: at(31), optOutMatched: false },
  };
  const thread = [reply, message("02", 20, "in"), message("01", 10), message("04", 40)];
  const classification = {
    ...{ label: "not_now", confidence: 0.62, isSuggested: true, origin: "model" },
    promptVersion: 1,
  };
  const line = replyLine({
    ...{ ...THREAD, reply, thread, classification },
    label: { label: "positive", classLabel: "interested", labeledAt: at(60) },
  });
  assert.deepEqual(line, {
    person_sha256: sha256("per_1"),
    thread_sha256: sha256("thr_1"),
    channel: "linkedin",
    label: "positive",
    class_label: "interested",
    labeled_at: "2026-10-27T10:00:00.000Z",
    received_at: "2026-10-27T09:31:00.000Z",
    text: "Yes [first_name] here",
    opt_out_matched: false,
    classification: {
      label: "not_now",
      confidence: 0.62,
      is_suggested: true,
      origin: "model",
      prompt_version: 1,
    },
    earlier: [
      {
        direction: "out",
        sent_by: "campaign",
        text: "01: hi [first_name]",
        at: at(10).toISOString(),
      },
      { direction: "in", sent_by: null, text: "02: hi [first_name]", at: at(20).toISOString() },
    ],
  });
  assert.doesNotMatch(JSON.stringify(line), /per_|thr_|msg_|Ottoline|Vashti/);
  // beta's row: no class; a reply the store's phrases matched, classified by them, no prompt.
  const phrase = { label: "opt_out", confidence: 1, isSuggested: false, origin: "phrase" };
  const other = replyLine({
    ...{ ...THREAD, thread, classification: { ...phrase, promptVersion: null } },
    reply: {
      ...reply,
      body: "Please stop, Ottoline Vashti is not interested",
      optOutMatched: true,
    },
    label: { label: "not_positive", classLabel: null, labeledAt: at(61) },
  });
  assert.deepEqual(
    [other.label, other.class_label, other.labeled_at, other.opt_out_matched],
    ["not_positive", null, at(61).toISOString(), true],
  );
  assert.deepEqual(other.classification, {
    ...{ label: "opt_out", confidence: 1, is_suggested: false, origin: "phrase" },
    prompt_version: null,
  });
  assert.equal(other.text, "Please stop, [first_name] [last_name] is not interested");
  const unclassified = replyLine({ ...THREAD, reply, thread, label: LABEL });
  assert.equal(unclassified.classification, null);
  assert.doesNotMatch(JSON.stringify([other, unclassified]), /per_|thr_|msg_|Ottoline|Vashti/);
});

test("earlier: the thread's messages sent before the reply, by sent_at then id, oldest first, the latest ten; the reply and what followed it left out", () => {
  const before = Array.from({ length: 12 }, (_, i) => message(`b${String(i).padStart(2, "0")}`, i));
  const reply = { ...message("r5", 20, "in"), receivedAt: at(20), optOutMatched: false };
  // Two messages at the reply's instant: the one with the smaller id came before it, the other after.
  const tieBefore = message("r1", 20);
  const tieAfter = message("r9", 20, "in");
  const after = [message("c01", 21), message("c02", 50, "in")];
  const thread = [...after, tieAfter, ...before.toReversed(), reply, tieBefore];
  const line = replyLine({ ...THREAD, reply, thread, label: LABEL });
  assert.equal(line.earlier.length, EXPORT_EARLIER_MAX);
  const latest = [...before.slice(-(EXPORT_EARLIER_MAX - 1)), tieBefore];
  assert.deepEqual(
    line.earlier.map(({ text, at }) => [tagOf(text), at]),
    latest.map(({ body, sentAt }) => [tagOf(body), sentAt.toISOString()]),
  );
  const opening = { ...message("a", 0, "in"), receivedAt: at(0), optOutMatched: false };
  const first = replyLine({ ...THREAD, reply: opening, thread, label: LABEL });
  assert.deepEqual(first.earlier, [], "a reply that opens the thread has nothing before it");
});

test("the names masked: the first and last names as whole words, any case and script, in a reply and in every earlier text; a longer word, another name and a missing name left as they are", () => {
  const cases: [string, PersonNames, string][] = [
    ["Hi Ottoline, thanks", NAMES, "Hi [first_name], thanks"],
    [
      "OTTOLINE VASHTI here; ottoline's team",
      NAMES,
      "[first_name] [last_name] here; [first_name]'s team",
    ],
    ["Ottolines and Vashtina stay", NAMES, "Ottolines and Vashtina stay"],
    ["Ask Bramwell, not Ottoline", NAMES, "Ask Bramwell, not [first_name]"],
    ["mail ottoline_v or 2Vashti", NAMES, "mail ottoline_v or 2Vashti"],
    [
      "Zoë ÅNGSTRÖM, zoë and Zoëy",
      { firstName: "Zoë", lastName: "Ångström" },
      "[first_name] [last_name], [first_name] and Zoëy",
    ],
    [
      "Anne-Marie and Marie",
      { firstName: "Anne-Marie", lastName: "Marie" },
      "[first_name] and [last_name]",
    ],
    [
      "Mr van  der Berg wrote",
      { firstName: "Saoirse", lastName: "van der Berg" },
      "Mr [last_name] wrote",
    ],
    [
      "J.R. (Jr.) wrote",
      { firstName: "J.R.", lastName: "(Jr.)" },
      "[first_name] [last_name] wrote",
    ],
    ["José wrote", { firstName: "José", lastName: null }, "[first_name] wrote"],
    ["Hi there", { firstName: null, lastName: " " }, "Hi there"],
  ];
  for (const [text, names, masked] of cases) assert.equal(maskNames(text, names), masked, text);
});

test("the week: its Monday at 00:00 UTC to the next; week_invalid for a week its year does not have, a malformed one or one not started", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  const utc = (day: string) => new Date(`${day}T00:00:00.000Z`);
  assert.deepEqual(weekRange("2026-W44", now), {
    start: utc("2026-10-26"),
    end: utc("2026-11-02"),
  });
  assert.deepEqual(weekRange("2026-W01", now), {
    start: utc("2025-12-29"),
    end: utc("2026-01-05"),
  });
  assert.deepEqual(weekRange("2020-W53", now).start, utc("2020-12-28"));
  for (const week of [
    "2025-W53",
    "2026-W00",
    "2026-W54",
    "2026-W60",
    "2026-44",
    "2026-W4",
    "soon",
    "",
  ]) {
    assert.throws(() => weekRange(week, now), weekInvalid, week);
  }
  // Not started: next week, and next year's first; the current week from its first instant.
  assert.throws(() => weekRange("2026-W45", now), weekInvalid);
  assert.throws(() => weekRange("2027-W01", now), weekInvalid);
  assert.deepEqual(weekRange("2026-W45", utc("2026-11-02")).start, utc("2026-11-02"));
});
