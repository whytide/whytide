// The alerts' repeat window from the environment (env-settings-b; README "Configuration", "Alerts"),
// pure like tests/alerts.test.ts: set to 60 minutes before the host's config loads, ten identical
// alerts within 59 minutes send one, and the next at 60 minutes carries ×9. Not an integer of 1 or
// more, ALERTS_REPEAT_MINUTES stops the config's load with config_invalid naming it, while a large
// value loads, read in a process of its own; the worker's start loads the config so.
// tests/alerts.test.ts runs the default, 15.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AlertsFake } from "@whytide/providers";
import type { Alert } from "../src/alerts.ts";

// Set before anything of the host loads: its config is read once, as it loads.
process.env.ALERTS_REPEAT_MINUTES = "60";
const { collectLogs, createLogger } = await import("@whytide/platform");
const { alertsPort, getAdapter } = await import("@whytide/providers");
const { createAlertQueue } = await import("../src/alerts.ts");
const { workerConfig } = await import("../src/config.ts");

const channel = await getAdapter(alertsPort, "fake");
const fake = channel as unknown as AlertsFake;
const T0 = Date.UTC(2026, 10, 15, 10);
const MINUTE = 60_000;

test("60 repeat minutes: ten identical alerts within 59 minutes send one; the next at 60 minutes carries ×9", async () => {
  assert.equal(workerConfig.ALERTS_REPEAT_MINUTES, 60);
  fake.reset();
  let clock = T0;
  const queue = createAlertQueue({
    send: (input) => channel.send(input),
    log: createLogger({ destination: collectLogs().destination }),
    now: () => clock,
    sleep: async () => {},
  });
  const alert: Alert = {
    kind: "activity",
    name: "signals_run_source",
    code: "linkedin_rate_limited",
  };
  for (const minute of [0, 15, 30, 45, 50, 55, 56, 57, 58, 59]) {
    clock = T0 + minute * MINUTE;
    queue.raise(alert);
  }
  await queue.drain();
  const text = "[test] activity signals_run_source linkedin_rate_limited";
  assert.deepEqual(fake.sent(), [text], "the 15-minute default would have sent four");
  clock = T0 + 60 * MINUTE;
  queue.raise(alert);
  await queue.drain();
  assert.deepEqual(fake.sent(), [text, `${text} ×9`]);
});

/** What a process with `env` set reads as `entry` loads: the window, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../src/config.ts"): unknown {
  const script = [
    "try {",
    `  await import(${JSON.stringify(new URL(entry, import.meta.url).href)});`,
    `  const { workerConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});`,
    "  console.log(JSON.stringify(workerConfig.ALERTS_REPEAT_MINUTES));",
    "} catch (error) {",
    "  const names = error.details.variables.map((variable) => variable.split(':')[0]);",
    "  console.log(JSON.stringify([error.code, error.details.block, names]));",
    "}",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", ...env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("ALERTS_REPEAT_MINUTES is an integer of 1 or more with no maximum, 15 unset or empty; otherwise the config's load stops on config_invalid naming it, the alert queue's import included", () => {
  const name = "ALERTS_REPEAT_MINUTES";
  assert.deepEqual([loaded({}), loaded({ [name]: "" })], [15, 15]);
  assert.deepEqual([loaded({ [name]: "1" }), loaded({ [name]: "10000" })], [1, 10000]);
  const invalid = ["config_invalid", "apps/worker", [name]];
  for (const value of ["0", "-1", "1.5", "fifteen"]) {
    assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
  }
  // The start imports the queue, which reads the config: it stops the same way.
  assert.deepEqual(loaded({ [name]: "0" }, "../src/alerts.ts"), invalid, `${name} at start`);
});
