// raw.ts beside its safety case (../../tests/safety/mailbox-raw-checks.test.ts, which refuses each
// form through the port, before any call): the forms of a To it passes, each problem named by its
// field, never by a value, and ONE_RECIPIENT in linear time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ONE_RECIPIENT, TO_MAX_CHARS } from "../constants.ts";
import { rawMessage } from "../contract.ts";
import { messageIdFor } from "../message-id.ts";
import { rawMessageProblems } from "../raw.ts";

const LEAD = "lead@example.test";
const OTHER = "other.person@example.test";
const ID = messageIdFor({ idempotencyKey: "raw", domain: "example.test" });
const raw = (parts: { to?: string; headers?: string[]; messageId?: string } = {}) =>
  rawMessage({ from: "member@example.test", to: LEAD, messageId: ID, ...parts });

test("one To passes: the address alone, after a display name quoted or not, an encoded one, or folded", () => {
  const forms = [
    LEAD,
    `Lead Person <${LEAD}>`,
    `"Person, Lead" <${LEAD}>`,
    `=?UTF-8?B?w4dh?= <${LEAD}>`,
    `Lead\r\n <${LEAD}>`,
  ];
  for (const to of forms) assert.deepEqual(rawMessageProblems(raw({ to }), ID), [], to);
});

test("each problem names its field, never a value", () => {
  const cases: [string, string, string[]][] = [
    [
      raw({ headers: [`Cc: ${OTHER}`, `Resent-Bcc: ${OTHER}`] }),
      ID,
      ["a cc field", "a resent-bcc field"],
    ],
    [raw({ to: `${LEAD} (the lead)` }), ID, ["not exactly one To with one address"]],
    [raw({ to: `${"x".repeat(TO_MAX_CHARS)} <${LEAD}>` }), ID, ["a To over TO_MAX_CHARS"]],
    [
      raw({ headers: ["Not a header line"] }),
      ID,
      ["a header line that is neither a field nor a fold"],
    ],
    [` Folded: first\r\n${raw()}`, ID, ["a header line that is neither a field nor a fold"]],
    [
      raw({ messageId: "local@example.test" }),
      "local@example.test",
      ["a Message-ID not of the platform's form"],
    ],
    [raw({ headers: [`Message-ID: <${ID}>`] }), ID, ["not exactly one Message-ID"]],
  ];
  for (const [given, messageId, problems] of cases) {
    const found = rawMessageProblems(given, messageId);
    assert.deepEqual(found, problems);
    assert.ok(!found.join().includes(LEAD) && !found.join().includes(OTHER));
  }
});

test("ONE_RECIPIENT reads in linear time: a display name of 500,000 spaces and no address fails in under 50 ms", () => {
  const started = performance.now();
  assert.equal(ONE_RECIPIENT.test(`Lead${" ".repeat(500_000)}Person`), false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 50, `${elapsed.toFixed(1)} ms`);
});
