// A sequence's rules and its keys (gamma-p3-030; README.md "Campaigns and versions"), pure: each
// rule of validateSequence refuses its case with its details.rule, in the order they are checked;
// keyedSteps gives the keys by action and order, the positions, the channels and beta's hashes;
// the fallback rule (gamma-p3-060) and the warm-signal default, whose condition enters a hash only
// when set.
import assert from "node:assert/strict";
import test from "node:test";
import { isAppError } from "@whytide/platform";
import {
  FALLBACK_CONDITION,
  FALLBACK_DELAY,
  FIRST_MESSAGE_DELAY,
} from "../domain/campaigns/constants.ts";
import {
  keyedSteps,
  type SequenceInput,
  sameSteps,
  validateSequence,
} from "../domain/campaigns/sequence.ts";
import { TEMPLATE_STEPS } from "../domain/template/constants.ts";
import { stepTemplateHash } from "../domain/template/keys.ts";
import { WARM_SIGNAL_STEPS } from "../domain/template/warm-signal.ts";

const CONNECT = { action: "invite", delay: { anchor: "enrollment" } } as const;
const FIRST_MESSAGE = { action: "message", delay: FIRST_MESSAGE_DELAY } as const;
const after = (value: number) => ({ anchor: "prev_step", unit: "business_days", value }) as const;
const message = (days = 3) => ({ action: "message", delay: after(days) }) as const;
const email = (days = 2) => ({ action: "email", delay: after(days) }) as const;
/** The fallback's first email, a week after the invitation, and a later one. */
const FALLBACK = { action: "email", delay: FALLBACK_DELAY, condition: FALLBACK_CONDITION } as const;
const fallback = (days = 3) => ({ ...email(days), condition: FALLBACK_CONDITION }) as const;

/** The rule a sequence breaks; null when it passes. */
function ruleOf(steps: readonly SequenceInput[]): unknown {
  try {
    validateSequence(steps);
    return null;
  } catch (error) {
    assert.ok(isAppError(error), String(error));
    assert.equal(error.code, "campaign_sequence_invalid");
    assert.equal(error.status, 400);
    return error.details?.rule;
  }
}

test("each rule refuses its case with its details.rule", () => {
  const eight = [CONNECT, FIRST_MESSAGE, message(), message(), email(), email(), email(), email()];
  const cases: [string, readonly SequenceInput[], string][] = [
    ["no step", [], "step_count"],
    ["eight steps", eight, "step_count"],
    [
      "an action no sequence has",
      [CONNECT, { action: "withdraw", delay: after(1) }],
      "step_action",
    ],
    ["no connection request first", [email(), CONNECT], "connect_first"],
    ["a connection request due later", [{ action: "invite", delay: after(1) }], "connect_first"],
    ["two connection requests", [CONNECT, { ...CONNECT }], "connect_once"],
    ["a fourth email", [CONNECT, email(), email(), email(), email()], "channel_limit"],
    [
      "a fourth LinkedIn message",
      [CONNECT, FIRST_MESSAGE, message(), message(), message()],
      "channel_limit",
    ],
    ["a message after an email in second place", [CONNECT, email(), message()], "first_message"],
    ["a first message not beta's draw", [CONNECT, message(1)], "first_message"],
    ["a delay of 0 business days", [CONNECT, FIRST_MESSAGE, message(0)], "step_delay"],
    ["a delay of 31 business days", [CONNECT, email(31)], "step_delay"],
    [
      "a delay counted from the acceptance later",
      [CONNECT, { action: "email", delay: FIRST_MESSAGE_DELAY }],
      "step_delay",
    ],
    ["a delay of half a day", [CONNECT, email(1.5)], "step_delay"],
    [
      "a delay with a field more",
      [CONNECT, { action: "email", delay: { ...after(2), x: 1 } }],
      "step_delay",
    ],
  ];
  for (const [name, steps, rule] of cases) assert.equal(ruleOf(steps), rule, name);
  for (const steps of [
    [CONNECT],
    [CONNECT, FIRST_MESSAGE],
    [CONNECT, email(1), email(30)],
    [CONNECT, FIRST_MESSAGE, message(), message(), email(), email(), email()],
  ]) {
    assert.equal(ruleOf(steps), null, JSON.stringify(steps.map(({ action }) => action)));
  }
});

test("keys are given by action and order, with positions, channels and beta's hashes", () => {
  const steps = keyedSteps(
    validateSequence([CONNECT, FIRST_MESSAGE, email(), message(4), email(5)]),
  );
  assert.deepEqual(
    steps.map(({ stepKey, position, action, channel }) => [stepKey, position, action, channel]),
    [
      ["connect", 1, "invite", "linkedin"],
      ["message_1", 2, "message", "linkedin"],
      ["email_1", 3, "email", "email"],
      ["follow_up_1", 4, "message", "linkedin"],
      ["email_2", 5, "email", "email"],
    ],
  );
  for (const step of steps) assert.equal(step.stepTemplateHash, stepTemplateHash(step));
  // Beta's template keyed again: its own keys, positions and hashes, so the same steps compare equal.
  const template = keyedSteps(validateSequence(TEMPLATE_STEPS));
  assert.deepEqual(
    template.map(({ stepKey, position, stepTemplateHash: hash }) => [stepKey, position, hash]),
    TEMPLATE_STEPS.map((step) => [step.stepKey, step.position, stepTemplateHash(step)]),
  );
  assert.ok(sameSteps(template, keyedSteps(validateSequence(TEMPLATE_STEPS))));
  // A changed delay changes that step's hash only; removing the first follow-up renames the second.
  const edited = keyedSteps(validateSequence([CONNECT, FIRST_MESSAGE, message(4), message(5)]));
  assert.equal(sameSteps(template, edited), false);
  assert.deepEqual(
    edited.map(({ stepTemplateHash: hash }, index) => hash === template[index]?.stepTemplateHash),
    [true, true, false, true],
  );
  const shorter = keyedSteps(validateSequence([CONNECT, FIRST_MESSAGE, message(5)]));
  assert.deepEqual(
    shorter.map(({ stepKey }) => stepKey),
    ["connect", "message_1", "follow_up_1"],
  );
});

test("the fallback rule: the condition on emails only, every one of them, as the last steps, the first a week after the invitation", () => {
  const marked = (step: SequenceInput) => ({ ...step, condition: FALLBACK_CONDITION });
  const cases: [string, readonly SequenceInput[], string][] = [
    ["on a LinkedIn message", [CONNECT, FIRST_MESSAGE, marked(message())], "fallback"],
    ["on the connection request", [marked(CONNECT), email()], "fallback"],
    [
      "a first email followed by a LinkedIn step",
      [CONNECT, FIRST_MESSAGE, FALLBACK, message()],
      "fallback",
    ],
    ["on the last email only", [CONNECT, email(), FALLBACK], "fallback"],
    ["on the first email only", [CONNECT, FALLBACK, email()], "fallback"],
    ["no connection request", [FALLBACK, fallback()], "connect_first"],
    ["the first on the step before", [CONNECT, fallback(2)], "fallback"],
    [
      "the first not 7 days after the invitation",
      [CONNECT, { ...FALLBACK, delay: { ...FALLBACK_DELAY, value: 3 } }],
      "fallback",
    ],
    [
      "a condition gamma does not have",
      [CONNECT, { ...email(), condition: "replied" }],
      "fallback",
    ],
    [
      "the invitation's anchor unmarked",
      [CONNECT, { action: "email", delay: FALLBACK_DELAY }],
      "step_delay",
    ],
    ["a later one on the invitation's anchor", [CONNECT, FALLBACK, FALLBACK], "step_delay"],
    ["a later one 0 business days on", [CONNECT, FALLBACK, fallback(0)], "step_delay"],
  ];
  for (const [name, steps, rule] of cases) assert.equal(ruleOf(steps), rule, name);
  for (const steps of [
    [CONNECT, FALLBACK],
    [CONNECT, FIRST_MESSAGE, message(), FALLBACK, fallback(), fallback(5)],
    WARM_SIGNAL_STEPS,
  ]) {
    assert.equal(ruleOf(steps), null, JSON.stringify(steps.map(({ action }) => action)));
  }
});

test("the warm-signal default keys its seven steps, the condition in the emails' hashes only", () => {
  const steps = keyedSteps(validateSequence(WARM_SIGNAL_STEPS));
  assert.deepEqual(
    steps.map(({ stepKey, action, condition }) => [stepKey, action, condition ?? null]),
    [
      ["connect", "invite", null],
      ["message_1", "message", null],
      ["follow_up_1", "message", null],
      ["follow_up_2", "message", null],
      ["email_1", "email", FALLBACK_CONDITION],
      ["email_2", "email", FALLBACK_CONDITION],
      ["email_3", "email", FALLBACK_CONDITION],
    ],
  );
  for (const step of steps) assert.equal(step.stepTemplateHash, stepTemplateHash(step));
  // Beta's connection request, first message and first follow-up are the same steps, with the same
  // hashes; follow_up_2 is 4 business days on, not beta's 5.
  const beta = TEMPLATE_STEPS.map((step) => stepTemplateHash(step));
  assert.deepEqual(
    steps.slice(0, 4).map(({ stepTemplateHash: hash }, index) => hash === beta[index]),
    [true, true, true, false],
  );
  // A condition changes the hash; none, or an undefined one, is a step without it.
  const [, , , , first, second] = steps;
  assert.ok(first && second);
  const unmarked = { ...second, condition: undefined };
  assert.notEqual(stepTemplateHash(second), stepTemplateHash(unmarked));
  const { condition: _, ...plain } = second;
  assert.equal(stepTemplateHash(unmarked), stepTemplateHash(plain));
});
