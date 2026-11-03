// The source-kind registry (alpha-p8-010; README.md "Adding a kind"): the generator lists every kind
// folder, and importing its list registers each kind, as the api's start does through the module's
// index. A test folder's kind joins with no change to the module's files: the list goes to .tmp/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAppError } from "@whytide/platform";
import { generateKindList } from "../scripts/kinds-generate.ts";
import { registeredSourceKinds, sourceKind } from "../sources/registry.ts";

const signals = resolve(import.meta.dirname, "..");
mkdirSync(join(signals, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(signals, ".tmp", "kinds-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const inModule = (path: string) => relative(signals, path);

/** Lists sources/ and the fixture folder in a file of its own under .tmp/ and imports the list. */
async function generateWith(fixtures: string): Promise<string[]> {
  const out = join(tmp, `${fixtures}.generated.ts`);
  const dirs = [join(signals, "sources"), join(signals, "tests", "fixtures", fixtures)];
  const files = generateKindList(dirs, out);
  await import(pathToFileURL(out).href);
  return files.map(inModule);
}

test("a kind in a test folder joins the registry, listed with sources/, with no change to the module's files", async () => {
  const before = [...registeredSourceKinds().keys()];
  assert.ok(before.includes("post_engagers"));
  const files = await generateWith("kinds");
  assert.ok(files.includes("sources/post_engagers/index.ts"));
  assert.equal(files.at(-1), "tests/fixtures/kinds/fixture_kind/index.ts");
  assert.deepEqual([...registeredSourceKinds().keys()], [...before, "fixture_kind"]);
  assert.equal(sourceKind("fixture_kind").labelKey, "signals.kinds.fixture_kind.label");
});

test("two kinds with one name fail to load, so the start fails, naming both files", async () => {
  await assert.rejects(generateWith("kinds-duplicate"), (error: unknown) => {
    assert.ok(isAppError(error));
    const { kind, sources } = error.details as { kind: string; sources: string[] };
    assert.deepEqual(
      [error.code, kind, sources.map((source) => inModule(fileURLToPath(source)))],
      [
        "signal_kind_duplicate",
        "post_engagers",
        [
          "sources/post_engagers/index.ts",
          "tests/fixtures/kinds-duplicate/post_engagers_again/index.ts",
        ],
      ],
    );
    return true;
  });
});
