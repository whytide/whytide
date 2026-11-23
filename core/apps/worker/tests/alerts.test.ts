// The host's alert queue (README "Alerts"; gamma-p7-040), pure: no Temporal and no database, the
// alerts fake as the team channel and a clock the tests set. The text holds the allowed parts only,
// never a name, an address, a LinkedIn URL, a message's text, an error's message or a URL; the keys;
// ten identical alerts within 15 minutes send one, and the next after the window carries ×9; the
// queue holds 100 at most, the oldest dropped and counted, and raise returns at once; a send gets 3
// attempts, waiting the channel's retryAfterSec or 1 s doubling, then the alert is dropped and logged
// with its code; with PROVIDER_ALERTS empty nothing is sent and the start logs `worker: team channel
// off` once.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { collectLogs, createLogger, recordedMetrics } from "@whytide/platform";
import { ALERT_TEXT_MAX, type AlertsFake, alertsPort, getAdapter } from "@whytide/providers";
import {
  type Alert,
  alertKey,
  alertText,
  createAlertQueue,
  raiseAlert,
  startAlerts,
} from "../src/alerts.ts";
import { ALERT_QUEUE_MAX } from "../src/constants.ts";

const logs = collectLogs();
const log = createLogger({ destination: logs.destination });
const channel = await getAdapter(alertsPort, "fake");
const fake = channel as unknown as AlertsFake;
/** Thursday 22 October 2026, 10:00 UTC: the clock of the repeat window, moved by the tests. */
const T0 = Date.UTC(2026, 9, 22, 10);
const MINUTE = 60_000;
const SA = "sa_01JAB3K5ZQ7W9R2M4T6V8X0Y1C";
const HE = "lhe_01JAB3K5ZQ7W9R2M4T6V8X0Y1D";
const FAILED: Alert = {
  kind: "activity",
  name: "linkedin_send_invite",
  code: "linkedin_provider_error",
};
let clock = T0;
const waits: number[] = [];
const queueOf = () =>
  createAlertQueue({
    send: (input) => channel.send(input),
    log,
    now: () => clock,
    sleep: async (ms) => void waits.push(ms),
  });
const outcomes = () => (recordedMetrics().get("worker.alerts") ?? []).map((set) => set.outcome);
const linesOf = (msg: string) => logs.lines().filter((line) => line.msg === msg);

beforeEach(() => {
  fake.reset();
  clock = T0;
  waits.length = 0;
});

test("the text is [APP_ENV], the kind, the name and the code, an event's id fields and numbers or the outbox's count, ×n for a repeat, ALERT_TEXT_MAX at most", () => {
  assert.equal(alertText(FAILED), "[test] activity linkedin_send_invite linkedin_provider_error");
  const workflow: Alert = { kind: "workflow", name: "signals_run", code: "ActivityFailure" };
  assert.equal(alertText(workflow, 9), "[test] workflow signals_run ActivityFailure ×9");
  assert.equal(alertText({ kind: "outbox", name: "dead", count: 3 }), "[test] outbox dead count=3");
  const payload = { sender_account_id: SA, health_event_id: HE, warnings: 2 };
  assert.equal(
    alertText({ kind: "event", name: "linkedin.invites_paused", payload }),
    `[test] event linkedin.invites_paused sender_account_id=${SA} health_event_id=${HE} warnings=2`,
  );
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`n${i}`, 1_234_567_890]));
  const long = alertText({ kind: "event", name: "probe.counted", payload: many }, 4);
  assert.ok(long.length <= ALERT_TEXT_MAX, `${long.length} characters`);
  assert.ok(long.endsWith(" ×4"));
});

test("the keys: activity:<activity>:<code>, workflow:<type>:<code>, outbox:dead, event:<name>:<the payload's first id>", () => {
  assert.equal(alertKey(FAILED), "activity:linkedin_send_invite:linkedin_provider_error");
  const workflow: Alert = { kind: "workflow", name: "signals_run", code: "fixture_failed" };
  assert.equal(alertKey(workflow), "workflow:signals_run:fixture_failed");
  assert.equal(alertKey({ kind: "outbox", name: "dead", count: 4 }), "outbox:dead");
  const payload = { note_id: "not an id", sender_account_id: SA, health_event_id: HE };
  const event: Alert = { kind: "event", name: "linkedin.account_paused", payload };
  assert.equal(alertKey(event), `event:linkedin.account_paused:${SA}`);
});

test("a text never holds a name, an email address, a LinkedIn URL, a message's text, an error's message or a URL, whatever the payload and the error hold", () => {
  const error = new Error("Ada Lovelace <ada@example.com> wrote https://www.linkedin.com/in/ada");
  const kept = [
    "Ada",
    "Lovelace",
    "ada@example.com",
    "linkedin.com/in/ada",
    "Hello Ada, about your post",
    "example.org",
    "<!channel>",
    "@everyone",
  ];
  const alerts: Alert[] = [
    { kind: "activity", name: "linkedin_send_message", code: error.message },
    { kind: "activity", name: "Ada Lovelace", code: "<!channel>" },
    { kind: "workflow", name: "https://example.org/x", code: String(error) },
    { kind: "workflow", name: "signals_run", code: "@everyone" },
    {
      kind: "event",
      name: "linkedin.message_received",
      payload: {
        full_name: "Ada Lovelace",
        email: "ada@example.com",
        profile_url: "https://www.linkedin.com/in/ada",
        text: "Hello Ada, about your post",
        person_id: "Ada Lovelace",
        message_id: "https://example.org/x",
        mention_id: "@everyone",
        file_key: "raw/ada@example.com.json",
        error: error.message,
        stack: error.stack,
        nested: { email: "ada@example.com" },
        sender_account_id: SA,
      },
    },
  ];
  for (const alert of alerts) {
    const text = alertText(alert, 2);
    for (const value of kept) assert.ok(!text.includes(value), `${text} holds ${value}`);
    assert.doesNotMatch(text, /[@<>]|https?:|\/\//, text);
  }
  assert.equal(
    alertText(alerts[4] as Alert),
    `[test] event linkedin.message_received sender_account_id=${SA}`,
  );
});

test("ten identical alerts within 15 minutes send one; the next after the window carries ×9", async () => {
  const queue = queueOf();
  for (let minute = 0; minute < 10; minute++) {
    clock = T0 + minute * MINUTE;
    queue.raise(FAILED);
  }
  assert.equal(queue.size(), 1);
  await queue.drain();
  const text = "[test] activity linkedin_send_invite linkedin_provider_error";
  assert.deepEqual(fake.sent(), [text]);
  clock = T0 + 15 * MINUTE;
  queue.raise(FAILED);
  queue.raise(FAILED); // within the new window: counted again
  await queue.drain();
  assert.deepEqual(fake.sent(), [text, `${text} ×9`]);
  assert.ok(outcomes().includes("repeated") && outcomes().includes("sent"));
});

test("the queue never holds more than 100 alerts: past it the oldest is dropped and counted, and raise returns at once", async () => {
  const queue = queueOf();
  const answers = Array.from({ length: 150 }, (_, i) =>
    queue.raise({ kind: "activity", name: "probe_activity", code: `probe_code_${i}` }),
  );
  assert.ok(
    answers.every((answer) => answer === undefined),
    "nothing to wait for",
  );
  assert.equal(queue.size(), ALERT_QUEUE_MAX);
  await queue.drain();
  const sent = fake.sent();
  assert.equal(sent.length, ALERT_QUEUE_MAX);
  assert.equal(sent[0], "[test] activity probe_activity probe_code_50");
  assert.ok(outcomes().includes("dropped"));
});

test("a send gets 3 attempts, waiting the channel's retryAfterSec when given, else 1 s doubling, then the alert is dropped and logged with its code; a refusal is not tried again", async () => {
  const queue = queueOf();
  for (let i = 0; i < 3; i++) fake.failNext("alerts_unreachable", { status: 500 });
  queue.raise(FAILED);
  await queue.drain();
  assert.deepEqual(waits.splice(0), [1_000, 2_000]);
  assert.deepEqual([fake.sent(), fake.recordedCalls.length], [[], 3]);
  const dropped = () =>
    linesOf("worker: an alert was dropped").map((line) => [line.level, line.code, line.attempt]);
  assert.deepEqual(dropped(), [["warn", "alerts_unreachable", 3]]);
  assert.ok(outcomes().includes("failed"));

  fake.failNext("alerts_rate_limited", { retryAfterSec: 30 });
  queue.raise({ kind: "workflow", name: "signals_run", code: "fixture_failed" });
  await queue.drain();
  assert.deepEqual(waits.splice(0), [30_000]);
  assert.deepEqual(fake.sent(), ["[test] workflow signals_run fixture_failed"]);

  fake.failNext("alerts_rejected", { status: 404 });
  queue.raise({ kind: "outbox", name: "dead", count: 1 });
  await queue.drain();
  assert.deepEqual(waits, []);
  assert.deepEqual(dropped().at(-1), ["warn", "alerts_rejected", 1]);
});

test("with PROVIDER_ALERTS empty nothing is sent and the start logs `worker: team channel off` once; with the fake, an alert raised reaches it from the timer loop", async () => {
  const off = await startAlerts({ log, selector: "" });
  for (let i = 0; i < 3; i++) raiseAlert({ ...FAILED, code: `probe_off_${i}` });
  await sleep(50);
  await off.stop();
  assert.deepEqual(fake.recordedCalls, []);
  assert.equal(linesOf("worker: team channel off").length, 1);

  const on = await startAlerts({ log, selector: "fake" });
  try {
    raiseAlert(FAILED);
    const deadline = Date.now() + 5_000;
    while (fake.sent().length === 0 && Date.now() < deadline) await sleep(20);
    assert.deepEqual(fake.sent(), ["[test] activity linkedin_send_invite linkedin_provider_error"]);
  } finally {
    await on.stop();
  }
  raiseAlert({ ...FAILED, code: "probe_after_stop" });
  await sleep(50);
  assert.equal(fake.sent().length, 1, "nothing bound after the stop");
  assert.equal(linesOf("worker: team channel off").length, 1);
});
