// The suggest-below line from the environment (env-settings-a; README.md "Settings"), on a schema of
// the worktree's database and the LLM fake, as tests/classify.test.ts runs the classifier: set to
// 0.8 before the module loads, a model's interested at 0.75, which the default 0.7 would take, is
// stored suggested and campaigns acts on nothing, while one at 0.8 is taken. Not a number above 0
// and at most 1, the setting stops the module's load with config_invalid naming it, read in a
// process of its own, as playbooks' tests/limits.test.ts reads its limits; unset or empty, 0.7.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { beforeEach, test } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.INBOX_CLASSIFY_SUGGEST_BELOW = "0.8";
const { settings } = await import("../settings.ts");
const { answer, classifyFixture, llm } = await import("./classify-fixtures.ts");
const { HELD } = await import("./fixtures.ts");

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useTenancyClient(asRole("app"));
const { person, reply, classify, rowOf, stepsOf } = classifyFixture("wsp_inbox_settings");
beforeEach(() => llm.reset());

test("set to 0.8: interested at 0.75 is stored suggested and campaigns acts on nothing, the steps held; at 0.8 it is taken", async () => {
  assert.equal(settings.INBOX_CLASSIFY_SUGGEST_BELOW, 0.8);
  const below = await person("settings-below", "usr_below");
  const belowIds = await reply(below.personId, below.senderAccountId, "Sounds good, call me.");
  llm.script(answer("interested", 0.75));
  await classify(belowIds);
  const suggested = await rowOf(belowIds.messageId);
  assert.deepEqual(
    [suggested.label, suggested.isSuggested, suggested.actionsTaken],
    ["interested", true, { actions: [], enrollmentIds: [] }],
  );
  assert.deepEqual(await stepsOf(below.personId), HELD);

  const at = await person("settings-at", "usr_at");
  const atIds = await reply(at.personId, at.senderAccountId, "Sounds good, call me.");
  llm.script(answer("interested", 0.8));
  await classify(atIds);
  const taken = await rowOf(atIds.messageId);
  const { actions } = taken.actionsTaken as { actions: string[] };
  assert.deepEqual(
    [taken.label, taken.isSuggested, actions],
    ["interested", false, ["label_recorded", "notice_published"]],
  );
});

const NAME = "INBOX_CLASSIFY_SUGGEST_BELOW";

/** What a process with `env` set reads as `entry` loads: the line, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const href = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    "try {",
    `  await import(${href(entry)});`,
    `  const { settings } = await import(${href("../settings.ts")});`,
    `  console.log(JSON.stringify(settings.${NAME}));`,
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", PROVIDER_LLM: "fake", PROVIDER_LINKEDIN: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("the line is a number above 0 and at most 1, 0.7 unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.equal(loaded({}), 0.7);
  assert.equal(loaded({ [NAME]: "" }), 0.7);
  assert.equal(loaded({ [NAME]: "1" }), 1);
  assert.equal(loaded({ [NAME]: "0.01" }), 0.01);
  const invalid = ["config_invalid", "modules/inbox", [NAME]];
  for (const value of ["0", "-0.5", "1.01", "high"]) {
    assert.deepEqual(loaded({ [NAME]: value }), invalid, `${NAME}=${value}`);
  }
  // The hosts load the module's build: its index stops the same way.
  assert.deepEqual(loaded({ [NAME]: "0" }, "../dist/index.js"), invalid, `${NAME} at load`);
});
