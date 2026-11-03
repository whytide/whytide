// Unit test of the key convention parser: module.screen.purpose, with one more part for a mail's
// subject and body (alpha-p1-080).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isMessageKey, parseKey } from "../i18n/keys.ts";

test("parseKey reads module.screen.purpose and the optional part", () => {
  assert.deepEqual(parseKey("contacts.list.empty"), {
    ok: true,
    key: { module: "contacts", screen: "list", purpose: "empty" },
  });
  assert.deepEqual(parseKey("identity.signin.link.subject"), {
    ok: true,
    key: { module: "identity", screen: "signin", purpose: "link", part: "subject" },
  });
  for (const good of [
    "contacts.errors.icp_not_found",
    "platform.error.generic",
    "ui.actions.save",
    "my-module.list.title",
    "contacts.list.step2",
  ]) {
    assert.equal(parseKey(good).ok, true, good);
  }
});

test("parseKey rejects the wrong number of segments, capitals, dashes outside the module and empty segments", () => {
  for (const bad of [
    "contacts.list",
    "contacts.list.empty.subject.more",
    "Contacts.list.empty",
    "contacts.List.empty",
    "contacts.list.Empty",
    "contacts..empty",
    "contacts.list.e-mail",
    "contacts.list.1st",
    ".list.empty",
    "contacts.list.empty.",
    "",
  ]) {
    const result = parseKey(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.ok(result.reason.length > 0, bad);
  }
});

test("isMessageKey tells a key from a path, a sentence or an icon name", () => {
  assert.equal(isMessageKey("contacts.nav.label"), true);
  assert.equal(isMessageKey("/contacts"), false);
  assert.equal(isMessageKey("Save changes."), false);
  assert.equal(isMessageKey("lucide.user"), false);
});
