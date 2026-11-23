// The port's own tests, and the task's end to end: PROVIDER_MAILBOX=fake through the config and the
// registry gives every mailbox the fake, on which the contract suite runs (connect, refresh, revoke,
// send, find, read new messages, read a thread, each code the fake answers); empty, each mailbox
// gets its provider's adapter, and any other name fails at start; every code is new to the
// registry, with its status, and in the README's table; messageIdFor; the exact key sets of the
// outputs and the events. PROVIDER_MAILBOX is set before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { promisify } from "node:util";
import { httpStatus, registeredErrors } from "@whytide/platform";
import type { AdapterDefinition } from "../../_pattern/index.ts";

process.env.PROVIDER_MAILBOX = "fake";
const { isFake, registeredAdapters } = await import("../../_pattern/index.ts");
const { getAdapter } = await import("../../registry.ts");
const { contractSuite } = await import("../../testing/index.ts");
const { mailboxCases } = await import("../contract.ts");
const { fakeWorld } = await import("../fake/tests/world.ts");
const { mailboxAdapterFor, mailboxConfig, mailboxEvent, mailboxPort, messageIdFor } = await import(
  "../port.ts"
);

const mailbox = await getAdapter(mailboxPort, mailboxAdapterFor("google"));
const fake = registeredAdapters(mailboxPort).get("fake");
assert.ok(fake, "the registry loaded the fake");
contractSuite(mailboxPort, fake as AdapterDefinition<typeof mailboxPort>, mailboxCases(fakeWorld));

test("PROVIDER_MAILBOX=fake gives every mailbox the fake through the registry; empty, each its provider's adapter", async () => {
  assert.equal(mailboxConfig.PROVIDER_MAILBOX, "fake");
  assert.deepEqual([mailboxAdapterFor("google"), mailboxAdapterFor("microsoft")], ["fake", "fake"]);
  assert.ok(isFake(mailbox));
  assert.equal(await getAdapter(mailboxPort, mailboxAdapterFor("microsoft")), mailbox);
  const unset = { PROVIDER_MAILBOX: undefined };
  assert.deepEqual(
    [mailboxAdapterFor("google", unset), mailboxAdapterFor("microsoft", unset)],
    ["google", "microsoft"],
  );
});

test("any other PROVIDER_MAILBOX fails at start: an unknown adapter, a name that is no folder name", async () => {
  const registry = JSON.stringify(import.meta.resolve("../../registry.ts"));
  const port = JSON.stringify(import.meta.resolve("../port.ts"));
  const script = [
    "try {",
    `  const { mailboxAdapterFor, mailboxPort } = await import(${port});`,
    `  const { getAdapter } = await import(${registry});`,
    "  await getAdapter(mailboxPort, mailboxAdapterFor('google'));",
    "  console.log('started');",
    "} catch (error) { console.log(error.code); }",
  ].join("\n");
  const startWith = (PROVIDER_MAILBOX: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV: "test", PROVIDER_MAILBOX },
    }).then(({ stdout }) => stdout.trim());
  const started = await Promise.all(["fake", "postmark", "Not A Name"].map(startWith));
  assert.deepEqual(started, ["started", "provider_unknown", "config_invalid"]);
});

test("every code is new to the registry, with its status, and in the README's codes table", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = [...readme.matchAll(/^\| `(mailbox_[a-z_]+)` \((\d{3})\) \|/gm)];
  const table = Object.fromEntries(rows.map(([, code, status]) => [code, Number(status)]));
  const declared = Object.fromEntries(
    Object.keys(mailboxPort.errors).map((code) => [code, httpStatus(code)]),
  );
  assert.deepEqual(table, declared);
  const own = Object.values(mailboxPort.codes);
  assert.ok(own.every((code) => readme.includes(`\`${code}\``)));
  // definePort registered them, and a code registered twice would have thrown: no other owner.
  const registered = [...registeredErrors().keys()].filter((code) => code.startsWith("mailbox_"));
  assert.deepEqual(registered.toSorted(), [...Object.keys(declared), ...own].toSorted());
});

test("messageIdFor: one key one Message-ID every time, two keys two, the key nowhere in it, at the domain in lower case", () => {
  const key = "step-0001-send-email";
  const id = messageIdFor({ idempotencyKey: key, domain: "Example.TEST" });
  assert.equal(messageIdFor({ idempotencyKey: key, domain: "example.test" }), id);
  assert.notEqual(messageIdFor({ idempotencyKey: `${key}-2`, domain: "example.test" }), id);
  assert.match(id, /^wt-[0-9a-f]{64}@example\.test$/);
  assert.ok(!id.includes(key));
});

test("the exact key sets of the outputs and the events: a key added fails here", () => {
  const keys = (schema: unknown) =>
    Object.keys((schema as { shape: object }).shape)
      .toSorted()
      .join();
  const { methods } = mailboxPort;
  const outputs = Object.fromEntries(
    Object.entries(methods)
      .filter(([method]) => method !== "findSent")
      .map(([method, { output }]) => [method, keys(output)]),
  );
  assert.deepEqual(outputs, {
    createAuthUrl: "url",
    exchangeCode: "accessExpiresAt,accessToken,address,refreshToken,scopes",
    refreshAccess: "accessExpiresAt,accessToken,refreshToken",
    revokeAccess: "revoked",
    sendMessage: "messageId,messageRef,sentAt,threadRef",
    listNewMessages: "cursor,events,more",
    readThread: "events,more",
  });
  const found = (methods.findSent.output as unknown as { options: unknown[] }).options.map(keys);
  assert.deepEqual(found, ["found,messageRef,sentAt,threadRef", "found"]);
  const refs = "at,kind,messageRef,threadRef";
  assert.deepEqual(
    mailboxEvent.options.map(keys),
    [
      `${refs},fromAddress,inReplyTo,messageId,subject,text`,
      `${refs},messageId,subject,text`,
      `${refs},originalMessageId,permanent,status`,
      `${refs},feedbackType,originalMessageId`,
      `${refs},subject`,
    ].map((list) => list.split(",").toSorted().join()),
  );
});
