// The first name a reply mail carries (domain/mail.ts; README.md "The reply mail"): on one line, for
// the subject, without the marks that turn the text's direction; none for no name or one longer than
// any first name. The mail itself is the worker's core/apps/worker/tests/inbox-reply-mail.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { MAIL_NAME_MAX } from "../domain/constants.ts";
import { mailName } from "../domain/mail.ts";

test("a first name is kept on one line, its direction marks dropped", () => {
  assert.equal(mailName("Noor"), "Noor");
  assert.equal(mailName("  Anne\r\nMarie\t"), "Anne Marie");
  assert.equal(mailName("Zoë\u202e"), "Zoë");
  assert.equal(mailName("ممدوح"), "ممدوح");
});

test("no name, a blank one or one longer than any first name is none: the mail says a lead", () => {
  for (const name of [null, "", " \n ", "\u202e", "x".repeat(MAIL_NAME_MAX + 1)]) {
    assert.equal(mailName(name), null, JSON.stringify(name));
  }
  assert.equal(mailName("x".repeat(MAIL_NAME_MAX)), "x".repeat(MAIL_NAME_MAX));
});
