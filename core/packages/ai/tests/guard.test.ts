// The guardrails a run does not show (README.md "Mastra's guardrails"): no start with a Mastra
// license key, a default provider that refuses string ids, and Mastra imported once, after the guard.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import "../index.ts";

const root = join(import.meta.dirname, "..");
const entry = pathToFileURL(join(root, "index.ts")).href;

for (const [variable, value] of [
  ["MASTRA_LICENSE_KEY", "license-key-value"],
  ["MASTRA_EE_LICENSE", "ee-license-value"],
  ["MASTRA_LICENSE_KEY", ""],
] as const) {
  it(`refuses to start with ${variable} set${value ? "" : ", even empty"}`, () => {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`],
      { encoding: "utf8", env: { ...process.env, [variable]: value } },
    );
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, new RegExp(`ai_mastra_license_set[^]*variable: '${variable}'`));
    if (value) assert.ok(!child.stderr.includes(value));
  });
}

it("gives the AI SDK a default provider that refuses every model id", () => {
  const { AI_SDK_DEFAULT_PROVIDER: provider } = globalThis as { AI_SDK_DEFAULT_PROVIDER?: object };
  const { specificationVersion, ...kinds } = provider as Record<string, (id: string) => unknown>;
  assert.equal(specificationVersion, "v4");
  assert.ok(Object.keys(kinds).includes("languageModel"));
  for (const kind of Object.values(kinds)) {
    assert.throws(() => kind("anthropic/claude"), { code: "ai_model_id_refused" });
  }
});

it("imports Mastra from the allowed paths only, in one file, right after the guard", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "dist") return [];
      if (e.isDirectory()) return walk(join(dir, e.name));
      return e.name.endsWith(".ts") ? [join(dir, e.name)] : [];
    });
  const importers: string[] = [];
  for (const file of walk(root).map((path) => relative(root, path))) {
    const text = readFileSync(join(root, file), "utf8");
    const found = [...text.matchAll(/(?:from|import)\s*\(?\s*"((?:@mastra\/|mastra)[^"]*)"/g)];
    // A test may load Mastra's telemetry to prove that it stays off (tests/network.test.ts).
    const allowed = file.startsWith("tests/")
      ? /^@mastra\/core\/(agent|telemetry)$/
      : /^@mastra\/(core\/(agent|mastra|request-context|storage)|pg)$/;
    for (const [, specifier] of found) assert.match(specifier ?? "", allowed, file);
    if (found.length > 0 && !file.startsWith("tests/")) importers.push(file);
  }
  assert.deepEqual(importers, ["mastra/instance.ts"]);
  const imports = readFileSync(join(root, "mastra/instance.ts"), "utf8").match(/^import .*$/gm);
  assert.equal(imports?.[0], 'import "../run/guard.ts";');
  // index.ts imports the guard first too: it runs before anything a host imports after @whytide/ai.
  const entryImports = readFileSync(join(root, "index.ts"), "utf8").match(/^import .*$/gm);
  assert.equal(entryImports?.[0], 'import "./run/guard.ts";');
});
