// The three settings from the environment (env-settings-a; README.md "Settings"), on the rules the
// queue and the edit report read: set to 2 days, 48 hours and 0.1 before the module loads, an item
// pending 2 days needs attention, the window campaigns' queue reads is 48 hours, and an edit of 0.15
// is no longer small. Off its range, each stops the module's load with config_invalid naming it,
// read in a process of its own, as playbooks' tests/limits.test.ts reads its limits; unset or
// empty, 3, 24 and 0.2. tests/items.test.ts runs the defaults.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Set before anything of the module loads: its settings are read once, as it loads.
process.env.APPROVALS_NEEDS_ATTENTION_AFTER_DAYS = "2";
process.env.APPROVALS_QUEUE_WINDOW_HOURS = "48";
process.env.APPROVALS_SMALL_EDIT_MAX_RATIO = "0.1";
const { countEdits, isSmallEdit, needsAttention } = await import("../domain/items/rules.ts");
const { queueWindowHours } = await import("../settings.ts");

const HOUR_MS = 3_600_000;
const NOW = new Date("2026-11-16T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);

test("set to 2 days: an item pending 48 hours needs attention, which the default 3 would not flag, and one pending 47 hours does not", () => {
  assert.equal(needsAttention(ago(48), NOW), true);
  assert.equal(needsAttention(ago(47), NOW), false);
});

test("set to 48 hours: the queue window campaigns reads through index.ts is 48", () => {
  assert.equal(queueWindowHours, 48);
});

test("set to 0.1: an edit of 0.1 is small, one of 0.15, small under the default 0.2, is not; the edit report counts so", () => {
  assert.deepEqual([isSmallEdit(0.1), isSmallEdit(0.15), isSmallEdit(0)], [true, false, false]);
  const draft = { actionType: "message", text: "Hello", editedByUser: true } as const;
  const stats = countEdits([0.05, 0.1, 0.15].map((editRatio) => ({ ...draft, editRatio })));
  assert.deepEqual(stats, { approved: 3, unedited: 0, smallEdits: 2 });
});

const NAMES = [
  "APPROVALS_NEEDS_ATTENTION_AFTER_DAYS",
  "APPROVALS_QUEUE_WINDOW_HOURS",
  "APPROVALS_SMALL_EDIT_MAX_RATIO",
] as const;

/** What a process with `env` set reads as `entry` loads: the three, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const href = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    "try {",
    `  const { queueWindowHours } = await import(${href(entry)});`,
    `  const { settings } = await import(${href("../settings.ts")});`,
    `  const names = ${JSON.stringify(NAMES)};`,
    "  console.log(JSON.stringify([...names.map((name) => settings[name]), queueWindowHours]));",
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

test("the days and hours are integers of 1 or more with no maximum, the ratio above 0 and at most 1, the defaults unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.deepEqual(loaded({}), [3, 24, 0.2, 24]);
  const empty = Object.fromEntries(NAMES.map((name) => [name, ""]));
  assert.deepEqual(loaded(empty), [3, 24, 0.2, 24]);
  const [days, hours, ratio] = NAMES;
  const large = { [days]: "1000", [hours]: "1000", [ratio]: "1" };
  assert.deepEqual(loaded(large), [1000, 1000, 1, 1000]);
  // The hosts load the module's build: its index answers the window configured.
  assert.deepEqual(loaded(large, "../dist/index.js"), [1000, 1000, 1, 1000]);
  const off = {
    [days]: ["0", "-1", "1.5", "three"],
    [hours]: ["0", "-24", "0.5", "a day"],
    [ratio]: ["0", "-0.1", "1.5", "small"],
  };
  for (const name of NAMES) {
    const invalid = ["config_invalid", "modules/approvals", [name]];
    for (const value of off[name]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    assert.deepEqual(loaded({ [name]: "0" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});
