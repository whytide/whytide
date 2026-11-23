// The documents' limits from the environment (env-settings-b; README "Settings"), on the worktree's
// database: set to 10 files of 20 MB before the module loads, the script reads ten files, one of
// them exactly 20 MB, and refuses an eleventh and a file one byte past 20 MB; requestDraft takes ten
// documents and refuses eleven with documents_too_many, writing nothing. Not an integer of 1 or
// more, each setting stops the module's load with config_invalid naming it, while a large value
// loads, read in a process of its own; the api's and the worker's starts load the module so.
// tests/documents.test.ts and tests/cli.test.ts run the defaults, five files of 10 MB.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.ONBOARDING_MAX_FILES = "10";
process.env.ONBOARDING_MAX_FILE_BYTES = String(20 * 1024 * 1024);
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { servicePrincipal } = await import("@whytide/platform");
const { readDocuments } = await import("../cli/documents.ts");
const { getCompanyKnowledge } = await import("../domain/commands.ts");
const { requestDraft } = await import("../domain/draft.ts");
const { settings } = await import("../settings.ts");

withTestDb();
const MB = 1024 * 1024;
const onboarding = resolve(import.meta.dirname, "..");
mkdirSync(join(onboarding, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(onboarding, ".tmp", "document-limits-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("10 files of 20 MB: the script reads ten files, one of exactly 20 MB, and refuses an eleventh and a file of 20 MB and one byte", async () => {
  assert.deepEqual(
    [settings.ONBOARDING_MAX_FILES, settings.ONBOARDING_MAX_FILE_BYTES],
    [10, 20 * MB],
  );
  const full = join(tmp, "full.txt");
  writeFileSync(full, "a".repeat(20 * MB));
  const past = join(tmp, "past.txt");
  writeFileSync(past, "");
  truncateSync(past, 20 * MB + 1); // sparse: never read
  const small = Array.from({ length: 10 }, (_, at) => {
    const file = join(tmp, `part-${at}.txt`);
    writeFileSync(file, `Part ${at}`);
    return file;
  });
  const ten = await readDocuments([full, ...small.slice(0, 9)], tmp);
  assert.ok(ten.ok);
  assert.deepEqual(
    ten.documents.map(({ name, status }) => [name, status]),
    [["full.txt", "truncated"], ...small.slice(0, 9).map((_, at) => [`part-${at}.txt`, "read"])],
  );
  const eleven = await readDocuments([full, ...small], tmp);
  assert.deepEqual(eleven, { ok: false, code: "documents_too_many", file: small[9] });
  const large = await readDocuments([past], tmp);
  assert.deepEqual(large, { ok: false, code: "document_too_large", file: past });
});

test("10 files: requestDraft takes ten documents; eleven are documents_too_many, details.files 10, and nothing is written", async () => {
  const workspaceId = "wsp_document_limits";
  const app = asRole("app");
  const principal = servicePrincipal("onboarding_test");
  const draft = (count: number) =>
    withTenant(
      { workspaceId, principal },
      async () => {
        await getCompanyKnowledge(workspaceId);
        const documents = Array.from({ length: count }, (_, at) => ({
          ...{ name: `${at}.txt`, mediaType: "text/plain" as const },
          ...{ status: "read" as const, text: `Part ${at}` },
        }));
        return requestDraft(workspaceId, documents);
      },
      { client: app },
    );
  const drafts = () =>
    app.outboxEntry.count({ where: { workspaceId, eventName: "onboarding.draft_requested" } });
  await assert.rejects(draft(11), (error: { code?: string; details?: unknown }) => {
    assert.deepEqual([error.code, error.details], ["documents_too_many", { files: 10 }]);
    return true;
  });
  assert.deepEqual(
    [await app.companyDocument.count({ where: { workspaceId } }), await drafts()],
    [0, 0],
  );
  assert.equal((await draft(10)).fetchStatus, "fetching");
  assert.deepEqual(
    [await app.companyDocument.count({ where: { workspaceId } }), await drafts()],
    [10, 1],
  );
});

/** What a process with `env` set reads as the module loads: the two limits, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify([settings.ONBOARDING_MAX_FILES, settings.ONBOARDING_MAX_FILE_BYTES]));",
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", PROVIDER_LLM: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("each of the two is an integer of 1 or more with no maximum, 5 and 10 MB unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  const FILES = "ONBOARDING_MAX_FILES";
  const BYTES = "ONBOARDING_MAX_FILE_BYTES";
  assert.deepEqual(
    [loaded({}), loaded({ [FILES]: "", [BYTES]: "" })],
    [
      [5, 10 * MB],
      [5, 10 * MB],
    ],
  );
  assert.deepEqual(loaded({ [FILES]: "1000", [BYTES]: "1" }), [1000, 1]);
  for (const name of [FILES, BYTES]) {
    const invalid = ["config_invalid", "modules/onboarding", [name]];
    for (const value of ["0", "-1", "1.5", "ten"]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    // The hosts load the module's build: its index stops the same way.
    assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});
