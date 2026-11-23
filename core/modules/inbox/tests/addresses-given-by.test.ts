// The addresses a person gave (gamma-en-085; README.md "Addresses a person gave"), enrichment's
// `reply` source's reader, on a schema of the worktree's database, rows written by the module's test
// helpers: the person's own inbound messages only, newest first, the first 5 that hold an address,
// each one's addresses lower case and once; never an address of the workspace's own messages to
// them, another person's or another workspace's, and never a text.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { GIVEN_CHANNELS } from "../domain/addresses/constants.ts";
import { addressesGivenBy, addressesIn } from "../domain/addresses/given.ts";
import { createMessage, createThread } from "../testing/index.ts";

withTestDb();
const [A, B] = ["wsp_inbox_given_a", "wsp_inbox_given_b"];
const [JANE, OTHER] = ["per_inbox_given_jane", "per_inbox_given_other"];
const read = (workspaceId: string, personId: string) =>
  withTenant(
    { workspaceId, principal: servicePrincipal("inbox_test") },
    () => addressesGivenBy(personId),
    { client: asRole("app") },
  );
const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute));

test("the person's own inbound messages that hold an address, newest first, at most 5, each one's addresses lower case and once; the workspace's messages to them, another person's and another workspace's never; an answer that holds no text", async () => {
  const threadId = await createThread({ workspaceId: A, personId: JANE });
  const say = (minute: number, body: string, direction: "in" | "out" = "in") =>
    createMessage({
      workspaceId: A,
      threadId,
      personId: JANE,
      direction,
      body,
      sentAt: at(minute),
    });
  await say(1, "Sure. My email is Jane.Doe@Acme.com.");
  await say(2, "Write to sales@ourco.example or me@ourco.example", "out");
  await say(3, "Thanks, next week works.");
  await say(4, "Ping @Jane on the thread, not an address.");
  await say(5, "Copying my colleague: jane.doe@acme.com, Tom.Ray@acme.com and jane.doe@acme.com");
  for (const minute of [6, 7, 8, 9]) await say(minute, `Home: janed${minute}@gmail.com`);
  const otherThread = await createThread({ workspaceId: A, personId: OTHER });
  await createMessage({
    ...{ workspaceId: A, threadId: otherThread, personId: OTHER },
    body: "mine is other@acme.com",
  });
  const elsewhere = await createThread({ workspaceId: B, personId: JANE });
  await createMessage({
    ...{ workspaceId: B, threadId: elsewhere, personId: JANE, sentAt: at(30) },
    body: "b-only@acme.com",
  });

  const given = await read(A, JANE);
  assert.deepEqual(given, [
    ["janed9@gmail.com"],
    ["janed8@gmail.com"],
    ["janed7@gmail.com"],
    ["janed6@gmail.com"],
    ["jane.doe@acme.com", "tom.ray@acme.com"],
  ]);
  const text = JSON.stringify(given);
  for (const word of ["Home", "Copying", "colleague", "ourco", "other@", "b-only"]) {
    assert.ok(!text.includes(word), `the answer holds "${word}"`);
  }
  assert.deepEqual(await read(B, JANE), [["b-only@acme.com"]]);
  assert.deepEqual(await read(A, "per_inbox_given_nobody"), []);
  assert.deepEqual(await read(A, ""), []);
});

test("addressesIn reads each address around its @, without a sentence's full stop, a stray dot or a handle; nothing that is no address, nor a piece of a longer run", () => {
  assert.deepEqual(addressesIn("Mail me at jane.doe@acme.co.uk. Or (j_doe+work@mail.acme.com)!"), [
    "jane.doe@acme.co.uk",
    "j_doe+work@mail.acme.com",
  ]);
  assert.deepEqual(
    addressesIn("@jane, a@b, x@acme, ..@acme.com, user@-acme.com, a..b@acme.com"),
    [],
  );
  assert.deepEqual(addressesIn(`${"a".repeat(100)}@acme.com`), []);
});

test("LinkedIn threads only (GIVEN_CHANNELS): a message stored under the person in a thread that is not one of their LinkedIn threads is never read; email replies wait for gamma-p4-020 to drop quoted text", async () => {
  // The channel enum holds `linkedin` alone until gamma-p4-020: the reader reads the person's own
  // threads of GIVEN_CHANNELS, so a thread outside them, here another person's, is never read.
  const theirs = await createThread({ workspaceId: A, personId: "per_inbox_given_owner" });
  await createMessage({
    ...{ workspaceId: A, threadId: theirs, personId: "per_inbox_given_quoted" },
    body: "On Monday <sender@ourco.example> wrote: hello",
  });
  assert.deepEqual(GIVEN_CHANNELS, ["linkedin"]);
  assert.deepEqual(await read(A, "per_inbox_given_quoted"), []);
  const own = await createThread({ workspaceId: A, personId: "per_inbox_given_quoted" });
  await createMessage({
    ...{ workspaceId: A, threadId: own, personId: "per_inbox_given_quoted" },
    body: "mine: q.person@acme.example",
  });
  assert.deepEqual(await read(A, "per_inbox_given_quoted"), [["q.person@acme.example"]]);
});
