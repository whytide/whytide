// The port's own tests, outside any adapter: PROVIDER_LINKEDIN=fake through the registry gives the
// eleven methods and no other, an adapter missing one or adding a never-list method fails the shape
// check, no method name holds a never-list word (a type-level check), the exact key sets of
// Profile, Engager, the send side's outputs, the events and getAccountStatus's answer, the Profile
// schema keeps business fields only, and
// a module file importing the Unipile SDK fails vendor-sdk-in-adapter-only (written to a temporary
// workspace, as app-mail's test does: a fixture importing it would fail this package's own lint).
// PROVIDER_LINKEDIN is set before the config is imported, which reads it once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Engager, Profile } from "../port.ts";

process.env.PROVIDER_LINKEDIN = "fake";
const { bindPort, isFake } = await import("../../_pattern/index.ts");
const { getAdapter } = await import("../../registry.ts");
const { LINKEDIN_WEBHOOK_KINDS, linkedinConfig, linkedinEngager, linkedinPort, linkedinProfile } =
  await import("../port.ts");

const ELEVEN = [
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
];
// Type-level checks: none of these keys may ever exist on a Profile or an Engager, and no method
// name, lower-cased, holds a word of the never list (roadmaps/02-beta.md, "Rules we keep").
type Forbidden = "email" | "emails" | "phone" | "phones" | "photoUrl" | "birthday" | "pronouns";
const noContactInfo: [Extract<keyof Profile | keyof Engager, Forbidden>] extends [never]
  ? true
  : false = true;
type NeverWord = "like" | "comment" | "reshare" | "repost" | "endorse" | "inmail" | "contactinfo";
type MethodName = keyof typeof linkedinPort.methods & string;
const noNeverListMethod: [
  Extract<Lowercase<MethodName>, `${string}${NeverWord}${string}`>,
] extends [never]
  ? true
  : false = true;

test("PROVIDER_LINKEDIN=fake gives the fake through the registry, with exactly the eleven methods", async () => {
  assert.ok(noContactInfo && noNeverListMethod);
  assert.deepEqual(Object.keys(linkedinPort.methods), ELEVEN);
  const linkedin = await getAdapter(linkedinPort, linkedinConfig.PROVIDER_LINKEDIN);
  assert.ok(isFake(linkedin));
  for (const method of ELEVEN)
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
    ELEVEN.filter((name) => name !== "sendInvite"),
    { missing: ["sendInvite"], extra: [] },
  );
  mismatch([...ELEVEN, "likePost"], { missing: [], extra: ["likePost"] });
});

test("the exact key sets of Profile, Engager and the send side's six outputs: a key added fails here", () => {
  const keys = (schema: { readonly shape: object }) => Object.keys(schema.shape).toSorted();
  const { methods } = linkedinPort;
  const profile = [
    "companyName",
    "companyUrl",
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
