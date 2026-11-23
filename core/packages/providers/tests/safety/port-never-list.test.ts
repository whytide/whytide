// A safety case of beta-p0-010 (roadmaps/02-beta.md "Rules we keep even here", briefs RB-9.1.3;
// linkedin/README.md "What the port will never have"): no automated likes, comments, reshares,
// endorsements or InMail, and no "Contact info" harvesting. No method of the LinkedIn port holds a
// never-list word in its name, lower-cased: not in the types, where the checks below fail `tsc -b`,
// which test:safety runs first, the day such a method is added; not at run time, on the port, the
// fake the registry binds and the Unipile adapter, the post reads of gamma-p5-010 among them. An
// adapter cannot add one either: the shape check refuses a method the port does not declare.
//
// The one exception (gamma-en-087; the owner's decision of 2026-11-13, behind
// LINKEDIN_CONTACT_INFO_ENABLED): getContactEmails and its output, `{ emails }`. The list's contact
// words (contact, email, phone, address, birthday, messenger, website) stop every other method that
// would read the section, and no output of the port holds a contact field (emails, phones,
// addresses, birthday, messengers, websites, socials) but getContactEmails' `emails`. And the one
// caller: no code file outside the port's own folder and test folders calls getContactEmails, but
// the linkedin module's readContactEmails (core/modules/linkedin/domain/contact/read.ts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { z } from "zod";
import { bindPort } from "../../_pattern/index.ts";
import { linkedinPort } from "../../linkedin/port.ts";
import { unipileLinkedin } from "../../linkedin/unipile/index.ts";
import { getAdapter } from "../../registry.ts";

/** The never list, as words no method name holds once lower-cased. */
const NEVER = [
  "like",
  "comment",
  "reshare",
  "repost",
  "endorse",
  "inmail",
  "contactinfo",
  // The "Contact info" section's fields (gamma-en-087): only the exception below reads one.
  "contact",
  "email",
  "phone",
  "address",
  "birthday",
  "messenger",
  "website",
] as const;
/** The owner's one exception (2026-11-13): this method, and the one key of its output. */
const EXCEPTION = "getContactEmails";
const EXCEPTION_KEY = "emails";
/** No output key may be one of these, lower-cased, but the exception's own `emails`. */
const CONTACT_KEYS = new Set([
  "email",
  "emails",
  "phone",
  "phones",
  "address",
  "addresses",
  "adresses",
  "birthday",
  "birthdate",
  "messenger",
  "messengers",
  "websites",
  "socials",
  "contactinfo",
  "contact_info",
]);
/** The only file outside the port's folder and test folders that may call the exception. */
const CALLER = "modules/linkedin/domain/contact/read.ts";
/** The port's own folder, which defines it: the port, the contract, the fake and the adapter. */
const PORT_FOLDER = "packages/providers/linkedin/";

type NeverWord = (typeof NEVER)[number];
/** True when no name among N, lower-cased, holds a never-list word. */
type Clean<N> = [Extract<Lowercase<N & string>, `${string}${NeverWord}${string}`>] extends [never]
  ? true
  : false;
type Methods = keyof typeof linkedinPort.methods;

// The port's methods but the exception: tsc fails on this line the day one holds a never-list word.
const portClean: Clean<Exclude<Methods, typeof EXCEPTION>> = true;
// The check bites on every word, inside a camelCase name too.
type Missed = {
  [W in NeverWord]: Clean<`send${Capitalize<W>}Now`> extends true ? W : never;
}[NeverWord];
const everyWordCaught: [Missed] extends [never] ? true : false = true;
// @ts-expect-error a port with a likePost method fails the check
const withLikePost: Clean<Methods | "likePost"> = true;
// @ts-expect-error the exception is one method: a getContactPhones beside it fails the check
const withContactPhones: Clean<Exclude<Methods, typeof EXCEPTION> | "getContactPhones"> = true;
// @ts-expect-error nor may the exception's name be read as clean: it is excepted by name alone
const exceptionItself: Clean<typeof EXCEPTION> = true;

const onNeverList = (names: readonly string[]) =>
  names.filter(
    (name) => name !== EXCEPTION && NEVER.some((word) => name.toLowerCase().includes(word)),
  );

/** Every object key of a schema, as `path.key`, through objects, arrays, unions and wrappers. */
function keysOf(schema: z.ZodType, path: string): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, value]) => [
      `${path}.${key}`,
      ...keysOf(value as z.ZodType, `${path}.${key}`),
    ]);
  }
  const inner = [def.innerType, def.element, def.valueType, def.in, def.out, def.schema].filter(
    (value): value is z.ZodType => value instanceof z.ZodType,
  );
  const options = Array.isArray(def.options) ? (def.options as z.ZodType[]) : [];
  return [...inner, ...options].flatMap((child) => keysOf(child, path));
}

/** The keys of the outputs that name a contact field, the exception's own aside. */
function contactKeys(outputs: Readonly<Record<string, z.ZodType>>): string[] {
  return Object.entries(outputs)
    .flatMap(([method, output]) => keysOf(output, method))
    .filter((path) => path !== `${EXCEPTION}.${EXCEPTION_KEY}`)
    .filter((path) => CONTACT_KEYS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase()));
}

const outputsOf = (methods: Readonly<Record<string, { readonly output: z.ZodType }>>) =>
  Object.fromEntries(Object.entries(methods).map(([name, { output }]) => [name, output]));

/** The code files under `root` that name the exception, but its caller, the port's folder and tests. */
function callersOf(root: string): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        // Dependencies, builds and hidden folders (.next, .tmp) are no code of ours.
        const skip = ["node_modules", "dist", "generated", "tests"];
        if (!skip.includes(entry.name) && !entry.name.startsWith(".")) walk(path);
        continue;
      }
      if (!/\.(?:[cm]?ts|tsx|[cm]?js)$/.test(entry.name)) continue;
      const file = relative(root, path).split(sep).join("/");
      if (file === CALLER || file.startsWith(PORT_FOLDER)) continue;
      if (readFileSync(path, "utf8").includes(EXCEPTION)) found.push(file);
    }
  };
  walk(root);
  return found.toSorted();
}

test("no never-list method on the LinkedIn port: in the types, on the port, the bound fake and the Unipile adapter", async () => {
  assert.deepEqual(
    [portClean, everyWordCaught, withLikePost, withContactPhones, exceptionItself],
    [true, true, true, true, true],
  );
  const methods = Object.keys(linkedinPort.methods);
  for (const read of ["searchPosts", "listAuthorPosts", "listOwnPosts", EXCEPTION]) {
    assert.ok(methods.includes(read), `${read} is walked`);
  }
  assert.deepEqual(onNeverList(methods), []);
  // The fake's controls and helpers too: nothing a test can call there is on the list, its
  // seedContactEmails aside, the exception's seed (fake/index.ts).
  const fake = Object.keys(await getAdapter(linkedinPort, "fake"));
  assert.deepEqual(onNeverList(fake.filter((name) => name !== "seedContactEmails")), []);
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

test("the one exception, getContactEmails: its name alone; any other contact method is on the list", () => {
  assert.deepEqual(onNeverList([EXCEPTION]), []);
  const others = [
    "getContactInfo",
    "getContactPhones",
    "getContactEmail",
    "readEmails",
    "getPhones",
    "getAddresses",
    "getBirthday",
    "listMessengers",
    "getWebsites",
    "getcontactemails",
  ];
  assert.deepEqual(onNeverList(others), others);
});

test("no output of the port holds a contact field but getContactEmails' emails, which is exactly that key: lower-cased addresses, three at most, each once", () => {
  const { methods } = linkedinPort;
  assert.deepEqual(contactKeys(outputsOf(methods)), []);
  assert.deepEqual(Object.keys(methods.getContactEmails.output.shape), [EXCEPTION_KEY]);
  const { output } = methods.getContactEmails;
  assert.ok(output.safeParse({ emails: [] }).success);
  assert.ok(output.safeParse({ emails: ["ada@example.com", "ada.home@example.org"] }).success);
  const refused = [
    { emails: ["ada@example.com"], phones: ["+44 20 7946 0000"] },
    { emails: ["ada@example.com"], adresses: ["1 Example Street"] },
    { emails: ["ada@example.com"], birthdate: { day: 1, month: 1 } },
    { emails: ["Ada@Example.com"] },
    { emails: ["not an address"] },
    { emails: ["+44 20 7946 0000"] },
    { emails: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] },
    { emails: ["ada@example.com", "ada@example.com"] },
  ];
  for (const answer of refused) {
    assert.equal(output.safeParse(answer).success, false, JSON.stringify(answer));
  }
  // The walk bites: a phone on another output, or a second contact key beside emails, is found.
  const withPhone = {
    ...outputsOf(methods),
    getRelation: methods.getRelation.output.extend({ phones: z.array(z.string()) }),
    [EXCEPTION]: output.extend({ socials: z.array(z.object({ name: z.string() })) }),
    listAuthorPosts: z.object({
      posts: z.array(z.object({ author: z.union([z.object({ email: z.string() })]) })),
    }),
  };
  assert.deepEqual(contactKeys(withPhone), [
    "getRelation.phones",
    "listAuthorPosts.posts.author.email",
    `${EXCEPTION}.socials`,
  ]);
});

test("the one caller: no code file of core/ but the linkedin module's readContactEmails, the port's folder and test folders names getContactEmails", () => {
  const core = join(import.meta.dirname, "..", "..", "..", "..");
  assert.deepEqual(callersOf(core), []);
  // The check bites: a module file or a host file calling it is found; a test folder's is not.
  const root = mkdtempSync(join(tmpdir(), "whytide-contact-caller-"));
  try {
    const call = "await linkedin.getContactEmails({ providerAccountRef, memberRef });\n";
    const files = {
      [CALLER]: call,
      "packages/providers/linkedin/fake/index.ts": call,
      "modules/linkedin/domain/company/read.ts": call,
      "modules/enrichment/domain/sources/contact.ts": "const { getContactEmails } = linkedin;\n",
      "apps/worker/src/read.ts": 'linkedin["getContactEmails"](input);\n',
      "modules/linkedin/tests/read-contact-emails.test.ts": call,
      "modules/linkedin/domain/company/read.md": call,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    assert.deepEqual(callersOf(root), [
      "apps/worker/src/read.ts",
      "modules/enrichment/domain/sources/contact.ts",
      "modules/linkedin/domain/company/read.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
