// A safety case of beta-p0-010 (roadmaps/02-beta.md "Rules we keep even here", briefs RB-9.1.3;
// linkedin/README.md "What the port will never have"): no automated likes, comments, reshares,
// endorsements or InMail, and no "Contact info" harvesting. No method of the LinkedIn port holds a
// never-list word in its name, lower-cased: not in the types, where the checks below fail `tsc -b`,
// which test:safety runs first, the day such a method is added; not at run time, on the port, the
// fake the registry binds and the Unipile adapter. An adapter cannot add one either: the shape check
// refuses a method the port does not declare.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../_pattern/index.ts";
import { linkedinPort } from "../../linkedin/port.ts";
import { unipileLinkedin } from "../../linkedin/unipile/index.ts";
import { getAdapter } from "../../registry.ts";

/** The never list, as words no method name holds once lower-cased. */
const NEVER = ["like", "comment", "reshare", "repost", "endorse", "inmail", "contactinfo"] as const;
type NeverWord = (typeof NEVER)[number];
/** True when no name among N, lower-cased, holds a never-list word. */
type Clean<N> = [Extract<Lowercase<N & string>, `${string}${NeverWord}${string}`>] extends [never]
  ? true
  : false;
type Methods = keyof typeof linkedinPort.methods;

// The port's methods: tsc fails on this line the day one holds a never-list word.
const portClean: Clean<Methods> = true;
// The check bites on every word, inside a camelCase name too.
type Missed = {
  [W in NeverWord]: Clean<`send${Capitalize<W>}Now`> extends true ? W : never;
}[NeverWord];
const everyWordCaught: [Missed] extends [never] ? true : false = true;
// @ts-expect-error a port with a likePost method fails the check
const withLikePost: Clean<Methods | "likePost"> = true;

const onNeverList = (names: readonly string[]) =>
  names.filter((name) => NEVER.some((word) => name.toLowerCase().includes(word)));

test("no never-list method on the LinkedIn port: in the types, on the port, the bound fake and the Unipile adapter", async () => {
  assert.deepEqual([portClean, everyWordCaught, withLikePost], [true, true, true]);
  const methods = Object.keys(linkedinPort.methods);
  assert.deepEqual(onNeverList(methods), []);
  // The fake's controls and helpers too: nothing a test can call there is on the list.
  assert.deepEqual(onNeverList(Object.keys(await getAdapter(linkedinPort, "fake"))), []);
  // Made up for the run: the adapter is built, never called.
  const made = randomBytes(32).toString("hex");
  const unipile = unipileLinkedin({
    baseUrl: "https://api.unipile.test",
    apiKey: made,
    webhookSecret: made,
    cursorSecret: made,
  });
  assert.deepEqual(Object.keys(unipile).toSorted(), methods.toSorted());
});

test("an adapter exposing a never-list method fails the port's shape check", () => {
  const call = async () => {
    throw new Error("never called");
  };
  const names = [...Object.keys(linkedinPort.methods), "likePost", "endorseSkill"];
  const adapter = Object.fromEntries(names.map((name) => [name, call]));
  assert.throws(
    () => bindPort(linkedinPort, adapter as never, { adapter: "never-list" }),
    (error: unknown) => {
      assert.ok(isAppError(error) && error.code === "port_shape_mismatch");
      assert.deepEqual(error.details?.extra, ["likePost", "endorseSkill"]);
      return true;
    },
  );
});
