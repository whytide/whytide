// The end-to-end test of the i18n runtime and the message-key check (alpha-p1-080): the bundle is
// built from the fixture module trees under tests/fixtures/i18n/, and the check runs on a passing
// tree, a failing one and one with a key in two files. Run with `pnpm -F platform test`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { AppError } from "../errors/index.ts";
import { checkMessages, formatProblem } from "../i18n/check.ts";
import {
  buildMessages,
  createTranslator,
  formatDate,
  formatNumber,
  formatRelative,
  loadMessages,
  renderMail,
  resolveLocale,
  translateError,
} from "../i18n/index.ts";
import { workspaceRoot } from "../i18n/messages.ts";
import { lookup } from "../i18n/translator.ts";

const fixtures = join(import.meta.dirname, "fixtures", "i18n");
const pass = join(fixtures, "pass");
const fail = join(fixtures, "fail");
const duplicate = join(fixtures, "duplicate");
const temporary: string[] = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A throw-away tree of files, for a case the fixtures do not hold. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "whytide-i18n-"));
  temporary.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A module `m` with one message file. */
const moduleWith = (json: string) => tree({ "core/modules/m/messages/en.json": json });
const codeOf = (error: unknown) => (error instanceof AppError ? error.code : undefined);
/** What a call throws, or a failure when it returns. */
function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error;
  }
  return assert.fail("nothing was thrown");
}

test("the build merges the fixture modules into one nested bundle; only buildMessages writes it", () => {
  const messages = loadMessages("en", { root: pass });
  assert.equal(lookup(messages, "fixture.list.title"), "Things");
  assert.equal(lookup(messages, "other.list.title"), "Other things");
  assert.equal(lookup(messages, "ui.actions.save"), "Save");
  assert.equal(lookup(messages, "__module__.list.title"), undefined);
  assert.equal(existsSync(join(pass, "core", "packages", "platform")), false);
  const out = join(tree({}), "en.generated.json");
  assert.deepEqual(buildMessages("en", out, { root: pass }), messages);
  assert.equal(readFileSync(out, "utf8"), `${JSON.stringify(messages, null, 2)}\n`);
});

test("a second module with the same key fails the build with both file names", () => {
  const conflict = thrown(() => loadMessages("en", { root: duplicate }));
  assert.equal(conflict.code, "message_conflict");
  assert.deepEqual(conflict.details, {
    key: "fixture.list.title",
    files: ["core/modules/fixture/messages/en.json", "core/modules/other/messages/en.json"],
  });
  const { problems } = checkMessages(duplicate);
  const found = problems.find((p) => p.kind === "duplicate-key");
  assert.equal(found?.key, "fixture.list.title");
  assert.ok(found?.message.includes("core/modules/fixture/messages/en.json"));
});

test("the build rejects a key off the convention and keeps prototype names as plain keys", () => {
  const messages = loadMessages("en", {
    root: moduleWith('{ "m.constructor.title": "x", "m.list.constructor": "y" }'),
  });
  assert.equal(lookup(messages, "m.constructor.title"), "x");
  assert.equal(lookup(messages, "m.list.constructor"), "y");
  for (const bad of [
    '{ "m.__proto__.polluted": "z" }',
    '{ "m.list": "two segments" }',
    '{ "other.list.title": "the wrong folder" }',
  ]) {
    assert.throws(
      () => loadMessages("en", { root: moduleWith(bad) }),
      (error: unknown) => codeOf(error) === "invalid_messages",
      bad,
    );
  }
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("messages:check passes on the passing tree and counts what it read", () => {
  const { problems, summary } = checkMessages(pass);
  assert.deepEqual(problems, []);
  assert.deepEqual(summary, { files: 3, keys: 8, sources: 6, uses: 8, codes: 1 });
});

test("messages:check fails on a missing used key, an unused key, unbalanced braces, a key off the convention, an unsorted file, a key that is also a namespace, run-time keys and an error code without a key", () => {
  const { problems } = checkMessages(fail);
  const got = problems.map((p) => (p.key ? `${p.kind} ${p.key}` : p.kind)).sort();
  assert.deepEqual(got, [
    "bad-key fixture.list",
    "bad-key other.list.title",
    "dynamic-key",
    "dynamic-key",
    "dynamic-key",
    "error-code-without-key fixture.errors.missing_code",
    "invalid-icu fixture.list.broken",
    "invalid-icu fixture.list.stray",
    "missing-key fixture.list.missing",
    "namespace-conflict fixture.invite.mail",
    "namespace-conflict fixture.list",
    "unsorted fixture.list.broken",
    "unused-key fixture.list.unused",
  ]);
  const reasons = problems
    .filter((p) => p.kind === "dynamic-key")
    .map((p) => p.message)
    .sort();
  assert.match(reasons[0] ?? "", /computed or spread member of defineErrors/);
  assert.match(reasons[1] ?? "", /built at run time/);
  assert.match(reasons[2] ?? "", /namespace .* not a string literal/);
  for (const p of problems) {
    assert.match(formatProblem(p), /^core\/modules\/fixture\/\S+:\d+:\d+ [a-z-]+ \S/);
  }
});

test("a locale's file is found by its tag, then its script, then its language, then the default", () => {
  assert.equal(lookup(loadMessages("zh-Hant-TW", { root: pass }), "fixture.list.title"), "東西");
  assert.equal(lookup(loadMessages("zh-CN", { root: pass }), "fixture.list.title"), "东西");
  assert.equal(lookup(loadMessages("zh-CN", { root: pass }), "other.list.title"), "Other things");
  assert.equal(lookup(loadMessages("en-GB", { root: pass }), "fixture.list.title"), "Things");
  assert.throws(
    () => loadMessages("../../etc", { root: pass }),
    (error: unknown) => codeOf(error) === "invalid_locale",
  );
});

test("formatDate differs between en-US and en-GB; formatRelative speaks from the locale's rules", () => {
  const instant = new Date("2026-03-04T15:06:07Z");
  const options = { dateStyle: "medium", timeZone: "UTC" } as const;
  assert.equal(formatDate(instant, "en-US", options), "Mar 4, 2026");
  assert.equal(formatDate(instant, "en-GB", options), "4 Mar 2026");
  const now = new Date("2026-03-06T15:06:07Z");
  assert.equal(formatRelative(instant, "en", { now }), "2 days ago");
  assert.equal(formatRelative(instant, "fr", { now }), "avant-hier");
  assert.equal(formatRelative(instant, "fr", { now, numeric: "always" }), "il y a 2 jours");
  assert.equal(formatRelative(new Date("2026-03-05T15:06:07Z"), "en", { now }), "yesterday");
  assert.equal(formatRelative(new Date("2026-03-06T15:06:07Z"), "en", { now }), "now");
  assert.equal(formatRelative(new Date("2026-03-06T15:07:06.600Z"), "en", { now }), "in 1 minute");
  assert.equal(formatRelative(new Date("2026-05-06T15:06:07Z"), "en", { now }), "in 2 months");
  assert.equal(formatNumber(1234567.891, "en-US"), "1,234,567.891");
  assert.equal(formatNumber(1234567.891, "de-DE"), "1.234.567,891");
});

test("renderMail builds subject and body from <key>.subject and <key>.body through ICU", () => {
  const messages = loadMessages("en", { root: pass });
  assert.deepEqual(
    renderMail("fixture.invite.mail", { name: "Ada", count: 1 }, "en", { messages }),
    {
      subject: "Ada invited you",
      body: "You have 1 invitation.",
    },
  );
  assert.throws(
    () => renderMail("fixture.list.title", {}, "en", { messages }),
    (error: unknown) => codeOf(error) === "message_not_found",
  );
});

test("resolveLocale: the user's setting, then the browser, then the default; the bare tag, region kept", () => {
  const available = ["en", "fr", "zh-Hant"];
  assert.equal(resolveLocale("fr", "en-GB,en;q=0.8", { available }), "fr");
  assert.equal(resolveLocale(undefined, "de-DE,en-GB;q=0.9,en;q=0.8", { available }), "en-GB");
  assert.equal(
    resolveLocale(undefined, "en-US-u-ca-buddhist-nu-thai,en;q=0.5", { available }),
    "en-US",
  );
  assert.equal(resolveLocale("zh-Hant-TW", null, { available }), "zh-Hant-TW");
  assert.equal(resolveLocale(undefined, "fr;Q=0.2, en;q=0.5", { available }), "en");
  assert.equal(resolveLocale(undefined, "fr;q=abc, en;q=0.5", { available }), "en");
  assert.equal(resolveLocale("not a locale", "de;q=0.5, *;q=0.1", { available }), "en");
  assert.equal(resolveLocale(null, null), "en");
});

test("translateError: the module's key for the code, else the platform's generic message", () => {
  const t = createTranslator(
    {
      platform: { error: { generic: "Something went wrong." } },
      fixture: { errors: { thing_not_found: "There is no such thing." } },
    },
    "en",
  );
  assert.equal(translateError(t, "fixture", "thing_not_found"), "There is no such thing.");
  assert.equal(translateError(t, "fixture", "insufficient_credits"), "Something went wrong.");
  assert.equal(t.has("fixture.errors.thing_not_found"), true);
  assert.throws(
    () => t("fixture.errors.nope"),
    (error: unknown) => codeOf(error) === "message_not_found",
  );
});

test("the repository's own message files pass the check", () => {
  const { problems, summary } = checkMessages(workspaceRoot());
  assert.deepEqual(problems, []);
  assert.ok(summary.keys >= 1);
});
