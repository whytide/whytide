// The template, its hashes and its keys (README.md "Campaigns and versions"), pure: the four
// steps; a step's hash, the SHA-256 of its canonical definition; and the idempotency key, the same
// for the same workspace, person, template and step, different when any of them differs, and new
// when a step's delay or action changes. Then the writers' check of a reason code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkedCode } from "../domain/steps/codes.ts";
import { EXIT_DETAILS, STEP_REASON_CODES } from "../domain/steps/constants.ts";
import {
  FIRST_MESSAGE_DELAY_HOURS,
  MIN_MINUTES_AFTER_ACCEPTANCE,
  TEMPLATE_ID,
  TEMPLATE_STEPS,
  TEMPLATE_VERSION,
} from "../domain/template/constants.ts";
import { canonicalJson, idempotencyKey, stepTemplateHash } from "../domain/template/keys.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const [connect, message1, followUp1] = TEMPLATE_STEPS;
const parts = {
  workspaceId: "wsp_template_a",
  personId: "per_template_a",
  templateId: TEMPLATE_ID,
  stepTemplateHash: stepTemplateHash(connect),
};

test("the template: four steps, a connection request then three messages, on LinkedIn", () => {
  assert.deepEqual([TEMPLATE_ID, TEMPLATE_VERSION], ["linkedin_default", 1]);
  assert.deepEqual(
    TEMPLATE_STEPS.map(({ stepKey, position, action, channel }) => [
      stepKey,
      position,
      action,
      channel,
    ]),
    [
      ["connect", 1, "invite", "linkedin"],
      ["message_1", 2, "message", "linkedin"],
      ["follow_up_1", 3, "message", "linkedin"],
      ["follow_up_2", 4, "message", "linkedin"],
    ],
  );
  assert.deepEqual(
    TEMPLATE_STEPS.map(({ delay }) => delay),
    [
      { anchor: "enrollment" },
      { anchor: "accepted", unit: "hours", min: 1, max: 3, minMinutes: 10 },
      { anchor: "prev_step", unit: "business_days", value: 3 },
      { anchor: "prev_step", unit: "business_days", value: 5 },
    ],
  );
  assert.deepEqual(
    [FIRST_MESSAGE_DELAY_HOURS, MIN_MINUTES_AFTER_ACCEPTANCE],
    [{ min: 1, max: 3 }, 10],
  );
});

test("a step's hash is the SHA-256 of its step_key, action, delay and channel as JSON with sorted keys", () => {
  const definition =
    '{"action":"invite","channel":"linkedin","delay":{"anchor":"enrollment"},"step_key":"connect"}';
  assert.equal(stepTemplateHash(connect), sha256(definition));
  assert.match(stepTemplateHash(connect), /^[0-9a-f]{64}$/);
  // The order the definition is written in, and the position, are not in it.
  const { stepKey, action, delay, channel } = connect;
  const reordered = { position: 9, delay, channel, action, stepKey };
  assert.equal(stepTemplateHash(reordered), stepTemplateHash(connect));
  assert.equal(
    canonicalJson({ b: [2, { d: 1, c: undefined, a: 0 }], a: "x" }),
    '{"a":"x","b":[2,{"a":0,"d":1}]}',
  );
  const hashes = new Set(TEMPLATE_STEPS.map((step) => stepTemplateHash(step)));
  assert.equal(hashes.size, 4, "four distinct hashes");
});

test("a step's hash changes when its delay or its action changes: a new template version", () => {
  const later = { ...message1, delay: { ...message1.delay, max: 4 } };
  assert.notEqual(stepTemplateHash(later), stepTemplateHash(message1));
  const sooner = { ...followUp1, delay: { ...followUp1.delay, value: 2 } };
  assert.notEqual(stepTemplateHash(sooner), stepTemplateHash(followUp1));
  assert.notEqual(stepTemplateHash({ ...message1, action: "invite" }), stepTemplateHash(message1));
  const key = (hash: string) => idempotencyKey({ ...parts, stepTemplateHash: hash });
  assert.notEqual(key(stepTemplateHash(later)), key(stepTemplateHash(message1)));
});

test("the key: the SHA-256 of workspace, person, template and step hash joined by ':', stable, and distinct when any differs", () => {
  const { workspaceId, personId, templateId, stepTemplateHash: hash } = parts;
  assert.equal(idempotencyKey(parts), sha256(`${workspaceId}:${personId}:${templateId}:${hash}`));
  assert.equal(idempotencyKey({ ...parts }), idempotencyKey(parts), "stable");
  const others = [
    { ...parts, workspaceId: "wsp_template_b" },
    { ...parts, personId: "per_template_b" },
    { ...parts, templateId: "linkedin_other" },
    { ...parts, stepTemplateHash: stepTemplateHash(message1) },
  ];
  const keys = new Set([parts, ...others].map((each) => idempotencyKey(each)));
  assert.equal(keys.size, 5, "each difference makes another key");
});

test("a writer takes a reason code its list holds, and refuses any other without echoing it", () => {
  assert.equal(
    checkedCode(EXIT_DETAILS, "exit_detail", "recently_contacted"),
    "recently_contacted",
  );
  assert.equal(checkedCode(STEP_REASON_CODES, "skip_reason", "replied"), "replied");
  assert.throws(() => checkedCode(STEP_REASON_CODES, "skip_reason", "recently_contacted"), {
    message: "skip_reason: a code domain/steps/constants.ts does not list",
  });
  assert.throws(
    () => checkedCode(EXIT_DETAILS, "exit_detail", "Noor Haddad"),
    (error: Error) => {
      assert.doesNotMatch(error.message, /Noor/);
      return true;
    },
  );
});
