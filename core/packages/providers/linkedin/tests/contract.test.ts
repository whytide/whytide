// The port's own tests, outside any adapter: PROVIDER_LINKEDIN=fake through the registry gives the
// five methods and no other, an adapter with a sixth fails the shape check, the Profile schema keeps
// business fields only, and a module file importing the Unipile SDK fails vendor-sdk-in-adapter-only
// (written to a temporary workspace, as app-mail's test does: a fixture importing it would fail this
// package's own lint). PROVIDER_LINKEDIN is set before the config is imported, which reads it once.
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
const { linkedinConfig, linkedinPort, linkedinProfile } = await import("../port.ts");

const FIVE = [
  "createHostedAuthLink",
  "getAccountStatus",
  "listPostEngagers",
  "getProfile",
  "parseWebhook",
];
// A type-level check: none of these keys may ever exist on a Profile or an Engager.
type Forbidden = "email" | "emails" | "phone" | "phones" | "photoUrl" | "birthday" | "pronouns";
const noContactInfo: [Extract<keyof Profile | keyof Engager, Forbidden>] extends [never]
  ? true
  : false = true;

test("PROVIDER_LINKEDIN=fake gives the fake through the registry, with exactly the five methods", async () => {
  assert.ok(noContactInfo);
  assert.deepEqual(Object.keys(linkedinPort.methods), FIVE);
  const linkedin = await getAdapter(linkedinPort, linkedinConfig.PROVIDER_LINKEDIN);
  assert.ok(isFake(linkedin));
  for (const method of FIVE)
    assert.equal(typeof linkedin[method as keyof typeof linkedin], "function");
});

test("an adapter adding sendMessage fails the port's shape check", () => {
  const read = async () => {
    throw new Error("never called");
  };
  const adapter = Object.fromEntries([...FIVE, "sendMessage"].map((name) => [name, read]));
  assert.throws(
    () => bindPort(linkedinPort, adapter as never, { adapter: "fixture" }),
    (error: { code?: string; details?: { extra?: unknown } }) => {
      assert.equal(error.code, "port_shape_mismatch");
      assert.deepEqual(error.details?.extra, ["sendMessage"]);
      return true;
    },
  );
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
