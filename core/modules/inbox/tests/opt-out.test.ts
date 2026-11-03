// The opt-out phrases (domain/opt-out/; README.md "Decided here"): each phrase of the list, in any
// case, with punctuation and curly apostrophes around or inside it, matches as whole words anywhere;
// "stop" matches as the reply's first word only, and "please stop" as the whole reply only.
import assert from "node:assert/strict";
import test from "node:test";
import { OPT_OUT_PHRASES, OPT_OUT_REPLIES } from "../domain/opt-out/constants.ts";
import { foldText, matchesOptOut } from "../domain/opt-out/match.ts";

test("each phrase of the list matches, alone and inside a reply", () => {
  for (const phrase of OPT_OUT_PHRASES) {
    assert.equal(matchesOptOut(phrase), true, phrase);
    assert.equal(matchesOptOut(`Hi there. ${phrase} please, thanks!`), true, phrase);
  }
});

test("stop matches as the whole reply or its first word", () => {
  for (const text of [
    "stop",
    "STOP.",
    "Stop!",
    "  stop  ",
    "...Stop",
    "Stop, please.",
    "STOP!!! I said stop",
    "Stop sending me these",
  ]) {
    assert.equal(matchesOptOut(text), true, text);
  }
});

test("stop elsewhere in a reply is no request", () => {
  for (const text of [
    "can't stop thinking about it",
    "non-stop",
    "Non-stop meetings this week",
    "Feel free to stop by on Tuesday.",
    "Please stop by our booth on Tuesday",
  ]) {
    assert.equal(matchesOptOut(text), false, text);
  }
});

test("a request to stop mid-reply matches, and a whole reply of please stop", () => {
  for (const reply of OPT_OUT_REPLIES) assert.equal(matchesOptOut(reply), true, reply);
  for (const text of [
    "Please stop messaging me",
    "Can you stop contacting me",
    "Kindly stop sending me these",
    "Please stop.",
    "please, STOP!",
  ]) {
    assert.equal(matchesOptOut(text), true, text);
  }
});

test("case and punctuation do not matter", () => {
  for (const text of [
    "STOP.",
    "Stop!",
    "stop",
    "Please remove me",
    "Please REMOVE ME from your list.",
    "Remove   me,\nthanks",
    "Unsubscribe!!!",
    "(opt out)",
    "Opt-out",
    "Do not contact.",
    "Not interested, remove.",
    "Not interested,remove",
    "Not interested - remove",
  ]) {
    assert.equal(matchesOptOut(text), true, text);
  }
});

test("curly apostrophes and quotes fold to straight ones", () => {
  for (const text of [
    "Don’t contact me again.",
    "don‘t contact me",
    "DONʼT CONTACT ME",
    "Don't contact me",
    "“Stop”",
    "'stop'",
    '"remove me"',
  ]) {
    assert.equal(matchesOptOut(text), true, text);
  }
});

test("only whole words match", () => {
  for (const text of [
    "stopwatch",
    "nonstop",
    "Non-stopping fun",
    "unstoppable",
    "Please remove meeting notes",
    "unsubscribed",
    "Don't contact members",
    "Thanks, next week works.",
    "",
  ]) {
    assert.equal(matchesOptOut(text), false, text);
  }
});

test("a hyphen or a slash parts words: when in doubt, suppress", () => {
  for (const text of ["stop/remove me", "opt-out", "Remove-me please"]) {
    assert.equal(matchesOptOut(text), true, text);
  }
});

test("folding keeps letters of any script and drops the rest to one space", () => {
  assert.equal(foldText("  Ça  va?\tStop… "), "ça va stop");
  assert.equal(foldText("D’accord, l’été"), "d'accord l'été");
  assert.equal(foldText("'quoted' it's"), "quoted it's");
});
