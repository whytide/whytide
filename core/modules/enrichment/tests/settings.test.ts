// The switch of the lookup at find (gamma-wr-070; README "Settings"): ENRICHMENT_LOOKUP_AT_FIND is
// `true` when unset or empty, `true` or `false` as set, and anything else stops the module's load on
// config_invalid naming it, the build's index included. Read in a process of its own, as the module
// loads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const NAME = "ENRICHMENT_LOOKUP_AT_FIND";

/** What a process with `env` set reads as the module loads: the switch, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { settings } = await import(${JSON.stringify(new URL("../settings.ts", import.meta.url).href)});`,
    `  console.log(JSON.stringify(settings.${NAME}));`,
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

test("the switch is on unset, as set otherwise; a value that is not true or false stops the module's load on config_invalid, the build's index included", () => {
  assert.deepEqual(
    [loaded({}), loaded({ [NAME]: "true" }), loaded({ [NAME]: "false" })],
    [true, true, false],
  );
  const invalid = ["config_invalid", "modules/enrichment", [NAME]];
  for (const value of ["yes", "0", "False"]) {
    assert.deepEqual(loaded({ [NAME]: value }), invalid, value);
  }
  assert.deepEqual(loaded({ [NAME]: "yes" }, "../dist/index.js"), invalid, "at load");
});
