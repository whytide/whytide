// A safety case of gamma-p0-010 (briefs RB-12.3.4; mailbox/README.md "Sending once"): the mailbox
// fake ignores the step's idempotency key, as Gmail and Graph do, and records every call, so two
// sends with one key are two recorded sends and two messages in the mailbox, under one Message-ID:
// a caller that sends twice shows it. The one-send guarantee never rests on the adapter, but on the
// caller's reservation and findSent before any retry (gamma-p1-070). And the fake refuses to start
// under APP_ENV=production, directly and through the registry: it never stands in for a mailbox on
// a server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { connectByConsent, rawMessage } from "../../mailbox/contract.ts";
import { mailboxFake } from "../../mailbox/fake/index.ts";
import { mailboxPort, messageIdFor } from "../../mailbox/port.ts";
import { getAdapter } from "../../registry.ts";

const mailbox = await getAdapter(mailboxPort, "fake");

test("two sendMessage calls with one idempotencyKey record two sends and leave two messages, under one Message-ID", async () => {
  mailboxFake.reset();
  const { address, accessToken } = await connectByConsent(mailbox);
  const idempotencyKey = "step-key-0001";
  const messageId = messageIdFor({ idempotencyKey, domain: "example.test" });
  const raw = rawMessage({ from: address, to: "lead@example.test", messageId });
  const send = { accessToken, raw, messageId, idempotencyKey };
  const first = await mailbox.sendMessage(send);
  const second = await mailbox.sendMessage(send);
  assert.deepEqual(
    mailboxFake.recordedCalls.filter((call) => call.method === "sendMessage"),
    [
      { method: "sendMessage", input: send },
      { method: "sendMessage", input: send },
    ],
  );
  assert.notEqual(second.messageRef, first.messageRef, "a second message, not the first again");
  assert.deepEqual([first.messageId, second.messageId], [messageId, messageId]);
  for (const { threadRef } of [first, second]) {
    assert.ok(threadRef, "each in a thread");
    const { events } = await mailbox.readThread({ accessToken, address, threadRef, limit: 10 });
    assert.deepEqual(
      events.map((event) => [event.kind, event.kind === "sent" && event.messageId]),
      [["sent", messageId]],
    );
  }
});

test("the fake refuses APP_ENV=production with adapter_invalid, through the registry too", async () => {
  const fake = JSON.stringify(import.meta.resolve("../../mailbox/fake/index.ts"));
  const registry = JSON.stringify(import.meta.resolve("../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../../mailbox/port.ts"));
  const script = [
    `const { mailboxFakeAdapter } = await import(${fake});`,
    `const { getAdapter } = await import(${registry});`,
    `const { mailboxPort } = await import(${port});`,
    "const outcome = (run) => run().then(() => 'created', (error) => error.code);",
    "const direct = await outcome(async () => mailboxFakeAdapter.create());",
    "const registered = await outcome(() => getAdapter(mailboxPort, 'fake'));",
    "console.log(`${direct} ${registered}`);",
  ].join("\n");
  const runAs = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "production"].map(runAs)), [
    "test created created",
    "production adapter_invalid adapter_invalid",
  ]);
});
