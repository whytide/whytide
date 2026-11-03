// The port's own tests, outside any adapter. The address rule takes the plain shapes (the contract
// cases prove its refusals on every adapter). And the port's contract with the rest of the code
// (docs/rules/coding.md §6 rule 2): with the repository's tools/lint/vendor-sdks.json, a module file
// importing nodemailer fails vendor-sdk-in-adapter-only and app-mail/smtp/ imports it freely; the two
// files are written to a temporary workspace when the test runs, since a fixture importing nodemailer
// would fail this package's own lint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { plainAddress } from "../port.ts";

const repository = join(import.meta.dirname, "..", "..", "..", "..", "..");
const importsNodemailer =
  'import { createTransport } from "nodemailer";\nexport { createTransport };\n';

test("the address rule takes a plain address, a punycode domain and top-level domain included", () => {
  const taken = [
    "ada.lovelace+tag@example.test",
    "o'brien_2-x@sub.example.test",
    "ada@xn--bcher-kva.example", // bücher.example
    "ada@example.xn--p1ai", // example.рф
  ];
  for (const address of taken) assert.ok(plainAddress.safeParse(address).success, address);
});

test("a module file importing nodemailer fails vendor-sdk-in-adapter-only; app-mail/smtp/ passes", () => {
  const root = mkdtempSync(join(tmpdir(), "whytide-app-mail-lint-"));
  try {
    const files = {
      "pnpm-workspace.yaml": "",
      "tools/lint/vendor-sdks.json": readFileSync(join(repository, "tools/lint/vendor-sdks.json")),
      "core/modules/identity/api/sign-in.ts": importsNodemailer,
      "core/packages/providers/app-mail/smtp/index.ts": importsNodemailer,
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
      /^core\/modules\/identity\/api\/sign-in\.ts:1:\d+ vendor-sdk-in-adapter-only nodemailer is the SDK of the adapter in core\/packages\/providers\/app-mail\/smtp\//m,
    );
    assert.match(lint.stdout, /^1 problem in 1 file$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
