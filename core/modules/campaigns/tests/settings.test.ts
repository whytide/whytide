// The five settings from the environment (env-settings-a; README.md "Settings"), and approvals'
// queue window, which the queue reads, on the worktree's database in this file's schema, as
// tests/sequence.test.ts, tests/reply-actions.test.ts and tests/queue.test.ts run their defaults:
// set before the module loads, a 45-day delay is accepted, a not-interested reply blocks 365 days, a
// not-now reply's reminder falls 60 days after it, an out-of-office reply without a date pauses 10
// days and one with a date resumes 2 business days after it, and a step due in 47 hours is queued.
// Off its range, each stops the module's load with config_invalid naming it, read in a process of
// its own, as playbooks' tests/limits.test.ts reads its limits; unset or empty, the defaults.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError } from "@whytide/platform";

// Set before anything of the modules loads: their settings are read once, as they load.
Object.assign(process.env, {
  CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS: "45",
  CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS: "365",
  CAMPAIGNS_NOT_NOW_REMINDER_DAYS: "60",
  CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS: "10",
  CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS: "2",
  APPROVALS_QUEUE_WINDOW_HOURS: "48",
});
const { useLinkedinClient } = await import("@whytide/linkedin/testing");
const { FIRST_MESSAGE_DELAY } = await import("../domain/campaigns/constants.ts");
const { validateSequence } = await import("../domain/campaigns/sequence.ts");
const { holdForReply } = await import("../domain/hold.ts");
const { dueStepIds } = await import("../domain/queue/due.ts");
const { applyReplyLabel } = await import("../domain/replies/apply.ts");
const { outOfOfficeUntil } = await import("../domain/replies/pause-end.ts");
const { APPROVER, fixture } = await import("./fixtures.ts");

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const f = fixture("wsp_campaigns_settings");
const { app, run, account, enrolledLead, moveStep, dueAt } = f;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A Thursday morning; the sender account is in Berlin, an hour ahead of UTC in November. */
const REPLIED = new Date("2026-11-05T10:00:00Z");
const ZONE = "Europe/Berlin";

const CONNECT = { action: "invite", delay: { anchor: "enrollment" } } as const;
const FIRST_MESSAGE = { action: "message", delay: FIRST_MESSAGE_DELAY } as const;
const message = (value: number) =>
  ({ action: "message", delay: { anchor: "prev_step", unit: "business_days", value } }) as const;
/** The rule a sequence breaks; null when it passes. */
function ruleOf(steps: Parameters<typeof validateSequence>[0]): unknown {
  try {
    validateSequence(steps);
    return null;
  } catch (error) {
    assert.ok(isAppError(error), String(error));
    return error.details?.rule;
  }
}

test("CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS set to 45: a 45-day delay, refused under the default 30, is accepted; 46 is step_delay", () => {
  assert.equal(ruleOf([CONNECT, FIRST_MESSAGE, message(45)]), null);
  assert.equal(ruleOf([CONNECT, FIRST_MESSAGE, message(46)]), "step_delay");
});

/** A lead whose follow-up was due a day before the reply, held by the reply at REPLIED. */
async function heldLead(slug: string) {
  const lead = await enrolledLead(slug);
  const { personId, steps } = lead;
  await moveStep(steps.connect, "succeeded");
  await moveStep(steps.message_1, "succeeded");
  await dueAt(steps.follow_up_1, new Date(REPLIED.getTime() - DAY_MS));
  await run(() => holdForReply(personId, { at: REPLIED }));
  return lead;
}
const label = (personId: string, replyLabel: "not_now" | "not_interested") =>
  run(() =>
    applyReplyLabel(personId, {
      ...{ label: replyLabel, suggested: false, returnDate: null, repliedAt: REPLIED },
      ...{ threadId: "thr_settings", ownerUserId: APPROVER },
    }),
  );
const enrollmentRow = (id: string) => app().enrollment.findUniqueOrThrow({ where: { id } });

test("CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS set to 365: a not-interested reply blocks a new enrollment 365 days, not the default 180", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("settings-cool-down");
  assert.ok((await label(personId, "not_interested")).actions.includes("cool_down_set"));
  const until = new Date(REPLIED.getTime() + 365 * DAY_MS);
  assert.deepEqual((await enrollmentRow(enrollmentId)).coolDownUntil, until);
});

test("CAMPAIGNS_NOT_NOW_REMINDER_DAYS set to 60: a not-now reply's reminder falls 60 days after it, not the default 30", async () => {
  await account(ZONE);
  const { personId, enrollmentId } = await heldLead("settings-not-now");
  assert.deepEqual((await label(personId, "not_now")).actions, ["label_recorded", "reminder_set"]);
  const remindAt = new Date(REPLIED.getTime() + 60 * DAY_MS);
  assert.deepEqual((await enrollmentRow(enrollmentId)).remindAt, remindAt);
});

test("CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS set to 10: an out-of-office reply without a return date pauses 10 days, not the default 7", () => {
  const until = outOfOfficeUntil({ returnDate: null, repliedAt: REPLIED, timeZone: ZONE });
  assert.equal(until.getTime() - REPLIED.getTime(), 10 * DAY_MS);
});

test("CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS set to 2: a Friday's return resumes on the Tuesday at 09:00 in the sender's zone, not the default Monday", () => {
  const until = outOfOfficeUntil({ returnDate: "2026-11-13", repliedAt: REPLIED, timeZone: ZONE });
  assert.equal(until.toISOString(), "2026-11-17T08:00:00.000Z");
});

test("APPROVALS_QUEUE_WINDOW_HOURS set to 48: the queue lists a step due in 47 hours, past the default 24, and not one due in 49", async () => {
  await account();
  const now = new Date();
  const soon = await enrolledLead("settings-window-soon");
  const later = await enrolledLead("settings-window-later");
  await dueAt(soon.steps.connect, new Date(now.getTime() + 47 * HOUR_MS));
  await dueAt(later.steps.connect, new Date(now.getTime() + 49 * HOUR_MS));
  assert.deepEqual(await run(() => dueStepIds(now)), [soon.steps.connect]);
});

const NAMES = [
  "CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS",
  "CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS",
  "CAMPAIGNS_NOT_NOW_REMINDER_DAYS",
  "CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS",
  "CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS",
] as const;
const [DELAY, COOL_DOWN, REMINDER, PAUSE, RESUME] = NAMES;

/** What a process with `env` set reads as `entry` loads: the five, or the error's code, block and variables. */
function loaded(env: Record<string, string>, entry = "../settings.ts"): unknown {
  const href = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    "try {",
    `  await import(${href(entry)});`,
    `  const { settings } = await import(${href("../settings.ts")});`,
    `  console.log(JSON.stringify(${JSON.stringify(NAMES)}.map((name) => settings[name])));`,
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

test("each is a whole number with no maximum, the delay 5 or more (the built-in sequences' longest), the resume 0 or more, the rest 1 or more, the defaults unset or empty; otherwise the module's load stops on config_invalid naming it, the build's index included", () => {
  assert.deepEqual(loaded({}), [30, 180, 30, 7, 1]);
  assert.deepEqual(
    loaded(Object.fromEntries(NAMES.map((name) => [name, ""]))),
    [30, 180, 30, 7, 1],
  );
  const least = { [DELAY]: "5", [COOL_DOWN]: "1", [REMINDER]: "1", [PAUSE]: "1", [RESUME]: "0" };
  assert.deepEqual(loaded(least), [5, 1, 1, 1, 0]);
  const large = Object.fromEntries(NAMES.map((name) => [name, "1000"]));
  assert.deepEqual(loaded(large, "../dist/index.js"), [1000, 1000, 1000, 1000, 1000]);
  const off: Record<(typeof NAMES)[number], string[]> = {
    [DELAY]: ["4", "0", "45.5", "a month"],
    [COOL_DOWN]: ["0", "-180", "1.5", "half a year"],
    [REMINDER]: ["0", "-30", "30.5", "a month"],
    [PAUSE]: ["0", "-7", "7.5", "a week"],
    [RESUME]: ["-1", "1.5", "a day"],
  };
  for (const name of NAMES) {
    const invalid = ["config_invalid", "modules/campaigns", [name]];
    for (const value of off[name]) {
      assert.deepEqual(loaded({ [name]: value }), invalid, `${name}=${value}`);
    }
    // The hosts load the module's build: its index stops the same way.
    assert.deepEqual(loaded({ [name]: "-1" }, "../dist/index.js"), invalid, `${name} at load`);
  }
});
