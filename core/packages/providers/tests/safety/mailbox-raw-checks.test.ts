// A safety case of gamma-p0-010 (the never list: no send to more than one recipient; F11 §6;
// mailbox/README.md "Sending once"): every raw message passes raw.ts's checks before any call. Each
// refused one is mailbox_input_invalid, names a field and never a value, and the fake records no
// send: an extra input key, a second recipient in To, two To fields, a Cc, a Bcc, a Message-ID
// unlike messageId, one not of the platform's form, two of them, bare LF line ends, a bare CR, and a
// raw message over MAILBOX_RAW_MAX_BYTES. A raw message of exactly that size is sent. A To over
// TO_MAX_CHARS is refused in under 50 ms, at the raw message's limit too; one at the bound is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { TO_MAX_CHARS } from "../../mailbox/constants.ts";
import { connectByConsent, rawMessage } from "../../mailbox/contract.ts";
import { mailboxFake } from "../../mailbox/fake/index.ts";
import { MAILBOX_RAW_MAX_BYTES, mailboxPort, messageIdFor } from "../../mailbox/port.ts";
import { getAdapter } from "../../registry.ts";

const mailbox = await getAdapter(mailboxPort, "fake");
const LEAD = "lead@example.test";
const OTHER = "second.person@example.test";
const messageId = messageIdFor({ idempotencyKey: "step-key-raw", domain: "example.test" });
const otherId = messageIdFor({ idempotencyKey: "step-key-other", domain: "example.test" });
/** A send of the raw message, the platform's Message-ID in both unless a case changes one. */
const sendOf = (accessToken: string, raw: string, id = messageId) => ({
  accessToken,
  raw,
  messageId: id,
  idempotencyKey: "step-key-raw",
});

test("each refused raw message is mailbox_input_invalid before any call: the fake records no send", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const raw = (parts: Partial<Parameters<typeof rawMessage>[0]> = {}) =>
    rawMessage({ from: address, to: LEAD, messageId, ...parts });
  const good = sendOf(accessToken, raw());
  const refused: Record<string, object> = {
    "an extra input key": { ...good, cc: OTHER },
    "a second recipient in To": sendOf(accessToken, raw({ to: `${LEAD}, ${OTHER}` })),
    "a group in To": sendOf(accessToken, raw({ to: `team: ${LEAD}, ${OTHER};` })),
    "two To fields": sendOf(accessToken, raw({ headers: [`To: ${OTHER}`] })),
    "a Cc": sendOf(accessToken, raw({ headers: [`Cc: ${OTHER}`] })),
    "a Bcc": sendOf(accessToken, raw({ headers: [`Bcc: ${OTHER}`] })),
    "a Bcc in another case, a space before its colon": sendOf(
      accessToken,
      raw({ headers: [`bcc : ${OTHER}`] }),
    ),
    "a Message-ID unlike messageId": sendOf(accessToken, raw({ messageId: otherId })),
    "a Message-ID not of the platform's form": sendOf(
      accessToken,
      raw({ messageId: "1234.abcd@example.test" }),
      "1234.abcd@example.test",
    ),
    "two Message-IDs": sendOf(accessToken, raw({ headers: [`Message-ID: <${otherId}>`] })),
    "bare LF line ends": sendOf(accessToken, raw().replaceAll("\r\n", "\n")),
    "a bare CR, a Bcc behind it in the subject": sendOf(
      accessToken,
      raw({ subject: `Hello\rBcc: ${OTHER}` }),
    ),
    "a raw message over MAILBOX_RAW_MAX_BYTES": sendOf(accessToken, sized(raw, 1)),
  };
  for (const [name, send] of Object.entries(refused)) {
    await assert.rejects(mailbox.sendMessage(send as never), (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "mailbox_input_invalid", `${name}: ${error}`);
      const said = JSON.stringify([error.message, error.details]);
      for (const value of [LEAD, OTHER, address])
        assert.ok(!said.includes(value), `${name}: ${value}`);
      return true;
    });
  }
  const sends = () => mailboxFake.recordedCalls.filter((call) => call.method === "sendMessage");
  assert.deepEqual(sends(), [], "no send recorded");
  // The bound itself passes: the same message at exactly MAILBOX_RAW_MAX_BYTES is sent.
  const atMost = sendOf(accessToken, sized(raw, 0));
  assert.equal(Buffer.byteLength(atMost.raw), MAILBOX_RAW_MAX_BYTES);
  assert.equal((await mailbox.sendMessage(atMost)).messageId, messageId);
  assert.equal(sends().length, 1);
});

test("a To over TO_MAX_CHARS is refused before its address is read, in under 50 ms, at the raw message's limit too; a To at the bound with a normal name is sent", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const raw = (to: string) => rawMessage({ from: address, to, messageId });
  const sends = () => mailboxFake.recordedCalls.filter((call) => call.method === "sendMessage");
  const tail = ` <${LEAD}>`;
  /** A To of `length` characters: a display name of words, then the address. */
  const named = (length: number) =>
    `${"Lead Person ".repeat(length).slice(0, length - tail.length)}${tail}`;
  // The reviewer's form: a display name of spaces and no address, which ONE_RECIPIENT once read in
  // quadratic time; here as long as the raw message allows.
  const spaced = `Lead${" ".repeat(MAILBOX_RAW_MAX_BYTES - Buffer.byteLength(raw("LeadPerson")))}Person`;
  const refused: [string, string][] = [
    ["a To just over the bound", named(TO_MAX_CHARS + 1)],
    ["a To of spaces to the raw message's limit", spaced],
  ];
  for (const [name, to] of refused) {
    const send = sendOf(accessToken, raw(to));
    const started = performance.now();
    await assert.rejects(mailbox.sendMessage(send), (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "mailbox_input_invalid", `${name}: ${error}`);
      return true;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 50, `${name}: refused in ${elapsed.toFixed(1)} ms`);
  }
  assert.equal(Buffer.byteLength(raw(spaced)), MAILBOX_RAW_MAX_BYTES);
  assert.deepEqual(sends(), [], "no send recorded");
  const atBound = named(TO_MAX_CHARS);
  assert.equal(atBound.length, TO_MAX_CHARS);
  assert.equal((await mailbox.sendMessage(sendOf(accessToken, raw(atBound)))).messageId, messageId);
  assert.equal(sends().length, 1);
});

/** The message padded to MAILBOX_RAW_MAX_BYTES and `over` bytes more, in its text. */
function sized(raw: (parts: { text: string }) => string, over: number): string {
  const base = Buffer.byteLength(raw({ text: "" }));
  return raw({ text: "x".repeat(MAILBOX_RAW_MAX_BYTES - base + over) });
}
