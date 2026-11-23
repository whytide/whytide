// The port's own tests, outside any adapter: PROVIDER_LINKEDIN=fake through the registry gives the
// sixteen methods and no other, an adapter missing one or adding a never-list method fails the
// shape check, no method name holds a never-list word (a type-level check), the exact key sets of
// Profile, Engager (dateKnown included), a post and both its authors, a company page (gamma-en-060),
// getContactEmails' `{ emails }` (the owner's exception, gamma-en-087), the send side's outputs, the
// events and getAccountStatus's answer, the Profile and post schemas keep business fields only, an
// author's link may hold a dot, the package exports the post bounds, an excerpt is cut between two
// graphemes, and a module file importing the Unipile SDK fails vendor-sdk-in-adapter-only (written
// to a temporary workspace, as app-mail's test does: a fixture importing it would fail this
// package's own lint). PROVIDER_LINKEDIN is set before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Engager, LinkedinCompany, LinkedinPost, PostAuthor, Profile } from "../port.ts";

process.env.PROVIDER_LINKEDIN = "fake";
const { bindPort, isFake } = await import("../../_pattern/index.ts");
const { getAdapter } = await import("../../registry.ts");
const {
  LINKEDIN_WEBHOOK_KINDS,
  linkedinCompany,
  linkedinConfig,
  linkedinEngager,
  linkedinPort,
  linkedinPost,
  linkedinProfile,
  postExcerpt,
} = await import("../port.ts");

const SIXTEEN = [
  "createHostedAuthLink",
  "getAccountStatus",
  "listPostEngagers",
  "getProfile",
  "parseWebhook",
  "sendInvite",
  "sendMessage",
  "withdrawInvite",
  "listPendingInvites",
  "listRecentMessages",
  "getRelation",
  "searchPosts",
  "listAuthorPosts",
  "listOwnPosts",
  "getCompany",
  "getContactEmails",
];
// Type-level checks: none of these keys may ever exist on a Profile, an Engager, a post or either of
// its authors, and no method name, lower-cased, holds a word of the never list (roadmaps/02-beta.md,
// "Rules we keep"), but the one exception, getContactEmails (the owner's, 2026-11-13; gamma-en-087).
type Forbidden = "email" | "emails" | "phone" | "phones" | "photoUrl" | "birthday" | "pronouns";
type KeysOf<T> = T extends unknown ? keyof T : never;
type Held = keyof Profile | keyof Engager | keyof LinkedinPost | KeysOf<PostAuthor>;
const noContactInfo: [Extract<Held, Forbidden>] extends [never] ? true : false = true;
// A company page holds no person's contact info either, nor a phone of its own (gamma-en-060).
const noContactOnCompany: [Extract<keyof LinkedinCompany, Forbidden>] extends [never]
  ? true
  : false = true;
type NeverWord = "like" | "comment" | "reshare" | "repost" | "endorse" | "inmail" | "contactinfo";
type MethodName = Exclude<keyof typeof linkedinPort.methods & string, "getContactEmails">;
const noNeverListMethod: [
  Extract<Lowercase<MethodName>, `${string}${NeverWord}${string}`>,
] extends [never]
  ? true
  : false = true;

test("PROVIDER_LINKEDIN=fake gives the fake through the registry, with exactly the sixteen methods", async () => {
  assert.ok(noContactInfo && noNeverListMethod && noContactOnCompany);
  assert.deepEqual(Object.keys(linkedinPort.methods), SIXTEEN);
  const linkedin = await getAdapter(linkedinPort, linkedinConfig.PROVIDER_LINKEDIN);
  assert.ok(isFake(linkedin));
  for (const method of SIXTEEN)
    assert.equal(typeof linkedin[method as keyof typeof linkedin], "function");
});

test("an adapter missing sendInvite, or adding a never-list method, fails the port's shape check", () => {
  const call = async () => {
    throw new Error("never called");
  };
  const adapterOf = (names: string[]) => Object.fromEntries(names.map((name) => [name, call]));
  const mismatch = (names: string[], expected: { missing: string[]; extra: string[] }) =>
    assert.throws(
      () => bindPort(linkedinPort, adapterOf(names) as never, { adapter: "fixture" }),
      (error: { code?: string; details?: { missing?: unknown; extra?: unknown } }) => {
        assert.equal(error.code, "port_shape_mismatch");
        const { missing, extra } = error.details ?? {};
        assert.deepEqual({ missing, extra }, expected);
        return true;
      },
    );
  mismatch(
    SIXTEEN.filter((name) => name !== "sendInvite"),
    { missing: ["sendInvite"], extra: [] },
  );
  mismatch([...SIXTEEN, "likePost"], { missing: [], extra: ["likePost"] });
});

test("the exact key sets of Profile, Engager, the send side's six outputs and getContactEmails': a key added fails here", () => {
  const keys = (schema: { readonly shape: object }) => Object.keys(schema.shape).toSorted();
  const { methods } = linkedinPort;
  const profile = [
    "companyName",
    "companyUrl",
    "connected",
    "fetchedAt",
    "firstName",
    "headline",
    "industry",
    "lastName",
    "locationText",
    "profileUrl",
    "providerMemberRef",
    "title",
  ];
  const engager = [
    "commentText",
    "dateKnown",
    "engagedAt",
    "headline",
    "name",
    "profileUrl",
    "providerMemberRef",
    "reaction",
  ];
  assert.deepEqual(keys(linkedinProfile), profile);
  assert.deepEqual(keys(methods.getProfile.output), profile);
  assert.deepEqual(keys(linkedinEngager), engager);
  assert.deepEqual(keys(methods.listPostEngagers.output.shape.engagers.element), engager);
  assert.deepEqual(keys(methods.sendInvite.output), ["invitationRef", "sentAt"]);
  assert.deepEqual(keys(methods.sendMessage.output), ["chatRef", "messageRef", "sentAt"]);
  assert.deepEqual(keys(methods.withdrawInvite.output), ["withdrawnAt"]);
  assert.deepEqual(keys(methods.listPendingInvites.output), ["invites", "nextCursor"]);
  assert.deepEqual(keys(methods.listPendingInvites.output.shape.invites.element), [
    "invitationRef",
    "memberRef",
    "sentAt",
  ]);
  assert.deepEqual(keys(methods.listRecentMessages.output), ["messages"]);
  assert.deepEqual(keys(methods.listRecentMessages.output.shape.messages.element), [
    "chatRef",
    "fromAccount",
    "messageRef",
    "sentAt",
  ]);
  assert.deepEqual(keys(methods.getRelation.output), ["connected", "invitationPending"]);
  // The owner's one exception (gamma-en-087): the email addresses, nothing else of the section.
  assert.deepEqual(keys(methods.getContactEmails.input), ["memberRef", "providerAccountRef"]);
  assert.deepEqual(keys(methods.getContactEmails.output), ["emails"]);
});

test("the events' exact key sets, one per kind of LINKEDIN_WEBHOOK_KINDS, and getAccountStatus's: a key added fails here", () => {
  const { getAccountStatus, parseWebhook } = linkedinPort.methods;
  const events = Object.fromEntries(
    parseWebhook.output.options.map((option) => [
      option.shape.kind.value,
      Object.keys(option.shape).toSorted(),
    ]),
  );
  assert.deepEqual(Object.keys(events), [...LINKEDIN_WEBHOOK_KINDS]);
  assert.deepEqual(events, {
    "account.connected": ["kind", "providerAccountRef", "providerRef"],
    "account.disconnected": ["kind", "providerAccountRef"],
    "account.credentials_required": ["kind", "providerAccountRef"],
    "account.status": ["kind", "providerAccountRef", "status"],
    "invite.accepted": ["eventKey", "kind", "memberRef", "occurredAt", "providerAccountRef"],
    "message.received": [
      "attendeeMemberRefs",
      "chatRef",
      "eventKey",
      "fromAccount",
      "kind",
      "messageRef",
      "providerAccountRef",
      "senderMemberRef",
      "sentAt",
      "text",
    ],
    ignored: ["kind"],
  });
  assert.deepEqual(Object.keys(getAccountStatus.output.shape).toSorted(), [
    "checkedAt",
    "memberRef",
    "status",
  ]);
});

test("the exact key sets of a post and of both its authors, the same in each read's output; Engager's dateKnown is a boolean it must give", () => {
  const keys = (schema: { readonly shape: object }) => Object.keys(schema.shape).toSorted();
  const authors = (union: { readonly options: readonly { readonly shape: object }[] }) =>
    union.options.map(keys);
  const post = ["author", "excerpt", "postUrl", "postedAt"];
  const member = ["headline", "kind", "name", "profileUrl", "providerMemberRef"];
  const company = ["companyUrl", "kind", "name"];
  assert.deepEqual(keys(linkedinPost), post);
  assert.deepEqual(authors(linkedinPost.shape.author), [member, company]);
  const { searchPosts, listAuthorPosts, listOwnPosts } = linkedinPort.methods;
  for (const { output } of [searchPosts, listAuthorPosts, listOwnPosts]) {
    assert.deepEqual(keys(output), ["nextCursor", "posts"]);
    assert.deepEqual(keys(output.shape.posts.element), post);
    assert.deepEqual(authors(output.shape.posts.element.shape.author), [member, company]);
  }
  assert.equal(linkedinEngager.shape.dateKnown.safeParse(undefined).success, false);
  assert.equal(linkedinEngager.shape.dateKnown.safeParse(false).success, true);
});

test("a post's schema drops a vendor's email, phone and photo on either author; a read's output refuses them", () => {
  const at = new Date("2026-10-22T08:00:00Z");
  const postUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001";
  const member = {
    kind: "member" as const,
    providerMemberRef: "member-1",
    profileUrl: "https://www.linkedin.com/in/ada-example",
    name: "Ada Example",
    headline: "Head of Growth at Example",
  };
  const company = {
    kind: "company" as const,
    companyUrl: "https://www.linkedin.com/company/example-ltd",
    name: "Example Ltd",
  };
  const vendor = {
    email: "ada@example.com",
    phone: "+44 20 7946 0000",
    photoUrl: "https://media.example/ada.jpg",
  };
  const { output } = linkedinPort.methods.listAuthorPosts;
  for (const author of [member, company]) {
    const post = { postUrl, postedAt: at, excerpt: "Sales automation, week 3", author };
    const sent = { ...post, likes: 12, author: { ...author, ...vendor } };
    assert.deepEqual(linkedinPost.parse(sent), post);
    assert.equal(output.safeParse({ posts: [sent], nextCursor: null }).success, false);
    assert.equal(output.safeParse({ posts: [post], nextCursor: null }).success, true);
  }
  // A link in no form listPostEngagers reads, and an author's page of the other kind, are refused.
  const profile = "https://www.linkedin.com/in/ada-example";
  const off = [
    { postUrl: profile, author: member },
    { postUrl, author: { ...member, profileUrl: company.companyUrl } },
    { postUrl, author: { ...company, companyUrl: profile } },
  ];
  for (const fields of off) {
    const post = { postedAt: at, excerpt: "", ...fields };
    assert.equal(linkedinPost.safeParse(post).success, false);
  }
});

test("an author's page whose id holds a dot, /in/jane.doe or /company/booking.com, passes a post's schema and listAuthorPosts' input", () => {
  const at = new Date("2026-10-22T08:00:00Z");
  const postUrl = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001";
  const profileUrl = "https://www.linkedin.com/in/jane.doe";
  const companyUrl = "https://www.linkedin.com/company/booking.com";
  const member = { kind: "member" as const, providerMemberRef: "member-2", profileUrl };
  const authors = [
    [{ ...member, name: "Jane Doe", headline: "" }, profileUrl],
    [{ kind: "company" as const, companyUrl, name: "Booking" }, companyUrl],
  ] as const;
  const { input } = linkedinPort.methods.listAuthorPosts;
  for (const [author, authorUrl] of authors) {
    const post = { postUrl, postedAt: at, excerpt: "", author };
    assert.deepEqual(linkedinPost.parse(post), post);
    const query = { providerAccountRef: "account-1", authorUrl, postedSince: at, limit: 1 };
    assert.ok(input.safeParse(query).success, authorUrl);
  }
});

test("@whytide/providers exports the post reads' bounds and AUTHOR_PATHS, for a caller's own checks", async () => {
  const providers = await import("../../index.ts");
  const constants = await import("../constants.ts");
  const names = [
    "AUTHOR_PATHS",
    "POST_EXCERPT_MAX_CHARS",
    "POST_PHRASE_MAX_CHARS",
    "POST_PHRASE_MAX_WORDS",
    "POSTS_PAGE_MAX",
  ] as const;
  for (const name of names) assert.equal(providers[name], constants[name], name);
});

test("an excerpt is the first 500 characters, cut between two graphemes: an emoji at the edge is whole or left out, never split", () => {
  const chars = (text: string) => Array.from(text).length;
  const a = (count: number) => "a".repeat(count);
  // One code point of two UTF-16 units at the edge: whole, the 500th character.
  assert.equal(postExcerpt(`${a(499)}😀b`), `${a(499)}😀`);
  // A family of five code points over the edge, a flag of two, a thumb and its skin tone: left out.
  assert.equal(postExcerpt(`${a(498)}👨‍👩‍👧 tail`), a(498));
  assert.equal(postExcerpt(`${a(499)}🇬🇧`), a(499));
  assert.equal(postExcerpt(`${a(499)}👍🏽`), a(499));
  // Short text unchanged; a lone surrogate made a character; never above 500.
  assert.equal(postExcerpt("Sales automation 👍🏽"), "Sales automation 👍🏽");
  assert.equal(postExcerpt("a\uD800b"), "a\uFFFDb");
  const long = postExcerpt("😀".repeat(600));
  assert.equal(chars(long), 500);
  assert.ok(long.isWellFormed());
  assert.equal(linkedinPost.shape.excerpt.safeParse(long).success, true);
  assert.equal(linkedinPost.shape.excerpt.safeParse(`${long}a`).success, false);
  assert.equal(linkedinPost.shape.excerpt.safeParse("a\uD800").success, false);
});

test("the Profile schema drops a vendor's email, phone and photoUrl", () => {
  const profile = {
    providerMemberRef: "member-1",
    profileUrl: "https://www.linkedin.com/in/ada-example",
    firstName: "Ada",
    lastName: "Example",
    headline: "Head of Growth at Example",
    title: "Head of Growth",
    companyName: "Example Ltd",
    locationText: "London, United Kingdom",
    fetchedAt: new Date("2026-10-22T08:00:00Z"),
  };
  const vendor = {
    ...profile,
    email: "ada@example.com",
    phone: "+44 20 7946 0000",
    photoUrl: "https://media.example/ada.jpg",
  };
  assert.deepEqual(linkedinProfile.parse(vendor), profile);
});

test("a module file importing unipile-node-sdk fails vendor-sdk-in-adapter-only; linkedin/unipile/ passes", () => {
  const repository = join(import.meta.dirname, "..", "..", "..", "..", "..");
  const importsSdk =
    'import { UnipileClient } from "unipile-node-sdk";\nexport { UnipileClient };\n';
  const root = mkdtempSync(join(tmpdir(), "whytide-linkedin-lint-"));
  try {
    const files = {
      "pnpm-workspace.yaml": "",
      "tools/lint/vendor-sdks.json": readFileSync(join(repository, "tools/lint/vendor-sdks.json")),
      "core/modules/linkedin/domain/read.ts": importsSdk,
      "core/packages/providers/linkedin/unipile/index.ts": importsSdk,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const lint = spawnSync(process.execPath, [join(repository, "tools/lint/lint.ts")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(lint.status, 1, lint.stdout + lint.stderr);
    assert.match(
      lint.stdout,
      /^core\/modules\/linkedin\/domain\/read\.ts:1:\d+ vendor-sdk-in-adapter-only unipile-node-sdk is the SDK of the adapter in core\/packages\/providers\/linkedin\/unipile\//m,
    );
    assert.match(lint.stdout, /^1 problem in 1 file$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the exact key set of a company page, the same in getCompany's output; its schema drops a vendor's phone, followers and employees, and the output refuses them", () => {
  const keys = (schema: { readonly shape: object }) => Object.keys(schema.shape).toSorted();
  const company = [
    "companyUrl",
    "description",
    "employeeCount",
    "employeeRange",
    "fetchedAt",
    "foundedYear",
    "headquartersCountry",
    "industry",
    "name",
    "website",
  ];
  const { getCompany } = linkedinPort.methods;
  assert.deepEqual(keys(linkedinCompany), company);
  assert.deepEqual(keys(getCompany.output), company);
  const page = {
    companyUrl: "https://www.linkedin.com/company/example-ltd",
    name: "Example Ltd",
    website: "https://example.com/",
    industry: "Software Development",
    employeeCount: 140,
    employeeRange: { from: 51, to: 200 },
    headquartersCountry: "GB",
    description: "A synthetic company.",
    foundedYear: 2012,
    fetchedAt: new Date("2026-11-13T08:00:00Z"),
  };
  const vendor = { ...page, phone: "+44 20 7946 0000", followers_count: 1200, employees: [] };
  assert.deepEqual(linkedinCompany.parse(vendor), page);
  assert.equal(getCompany.output.safeParse(vendor).success, false);
  assert.equal(getCompany.output.safeParse(page).success, true);
  const off = [
    { headquartersCountry: "United Kingdom" },
    { employeeRange: { from: 200, to: 51 } },
    { description: "a".repeat(2001) },
    { companyUrl: "https://www.linkedin.com/in/ada-example" },
  ];
  for (const fields of off)
    assert.equal(linkedinCompany.safeParse({ ...page, ...fields }).success, false);
  const input = { providerAccountRef: "account-1", companyUrl: "https://www.linkedin.com/in/ada" };
  assert.equal(getCompany.input.safeParse(input).success, false, "a member's page");
});
