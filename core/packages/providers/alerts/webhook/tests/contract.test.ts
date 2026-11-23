// The webhook adapter's tests (../README.md "Tests"), on a team channel at 127.0.0.1 (channel.ts),
// reached through EGRESS_ALLOW_HOSTS and never a real one: ALERTS_WEBHOOK_URL is set to the local
// channel's whatever the environment held. First the port's contract suite; then each answer the
// channel plays: exactly one POST of {"text": …} as JSON; a 302, its Location never followed; a 400
// and a 404; a 429 with and without Retry-After; a 500, a refused connection and no answer within
// ALERTS_TIMEOUT_MS; a body over ALERTS_ANSWER_MAX_BYTES, not read past it; and, in a child run, the
// suite skipped while ALERTS_WEBHOOK_URL is empty. The platform reads the egress lists when it is
// imported, so they are set first and everything that imports it is imported after.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AlertsChannel, AlertsFailure } from "../../contract.ts";
import { type Answer, closedUrl, startChannel } from "./channel.ts";

const PATH = "/services/T0TEST/B0TEST/local-channel";
process.env.EGRESS_ALLOW_HOSTS = "127.0.0.1";
delete process.env.EGRESS_DENY_HOSTS;
const channel = await startChannel(PATH);
process.env.ALERTS_WEBHOOK_URL = channel.url;
after(() => channel.close());

const { isAppError } = await import("@whytide/platform");
const { bindPort } = await import("../../../_pattern/index.ts");
const { contractSuite } = await import("../../../testing/index.ts");
const { alertsCases, RETRY_AFTER_SEC } = await import("../../contract.ts");
const { alertsPort } = await import("../../port.ts");
const { ALERTS_ANSWER_MAX_BYTES, ALERTS_TIMEOUT_MS } = await import("../constants.ts");
const { webhookAdapter } = await import("../index.ts");

/** The answer the channel plays for each of the contract's codes. */
const ANSWERS: Readonly<Record<AlertsFailure, Answer>> = {
  alerts_rejected: { status: 400, body: "invalid_payload" },
  alerts_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  alerts_unreachable: { status: 500 },
};
const local: AlertsChannel = {
  received: () => channel.requests.map((r) => (JSON.parse(r.body) as { text: string }).text),
  calls: () => channel.requests.length,
  failNext: (code) => channel.answerNext(ANSWERS[code]),
};
contractSuite(alertsPort, webhookAdapter, alertsCases(local));

/** The adapter started on `url`, ALERTS_WEBHOOK_URL put back after. */
function startedOn(url: string) {
  const saved = process.env.ALERTS_WEBHOOK_URL;
  process.env.ALERTS_WEBHOOK_URL = url;
  try {
    return bindPort(alertsPort, webhookAdapter.create(), { adapter: webhookAdapter.name });
  } finally {
    if (saved === undefined) delete process.env.ALERTS_WEBHOOK_URL;
    else process.env.ALERTS_WEBHOOK_URL = saved;
  }
}

const fails = (code: string, details: Record<string, unknown>) => (error: unknown) => {
  assert.ok(isAppError(error), String(error));
  assert.deepEqual([error.code, error.details], [code, details]);
  return true;
};

describe("the webhook adapter against each answer of a local channel", () => {
  const alerts = startedOn(channel.url);
  const text = "[test] outbox dead ×2";

  it('posts exactly once: {"text": …} as JSON, to the URL', async () => {
    const before = channel.requests.length;
    assert.deepEqual(await alerts.send({ text }), {});
    const body = JSON.stringify({ text });
    assert.deepEqual(channel.requests.slice(before), [
      { method: "POST", path: PATH, contentType: "application/json", body },
    ]);
  });

  it("a 302 is alerts_rejected, its Location never followed", async () => {
    const before = channel.requests.length;
    channel.answerNext({ status: 302, headers: { location: `${channel.origin}/followed` } });
    await assert.rejects(alerts.send({ text }), fails("alerts_rejected", { status: 302 }));
    assert.deepEqual(
      channel.requests.slice(before).map((request) => request.path),
      [PATH],
    );
  });

  it("a 400 and a 404 are alerts_rejected; a 500 is alerts_unreachable", async () => {
    const answers = [
      [400, "alerts_rejected"],
      [404, "alerts_rejected"],
      [500, "alerts_unreachable"],
    ] as const;
    for (const [status, code] of answers) {
      channel.answerNext({ status, body: "no" });
      await assert.rejects(alerts.send({ text }), fails(code, { status }));
    }
  });

  it("a 429 with Retry-After: 30 is alerts_rate_limited with retryAfterSec 30; without seconds, none", async () => {
    channel.answerNext({ status: 429, headers: { "retry-after": "30" } });
    const limited = { status: 429, retryAfterSec: 30 };
    await assert.rejects(alerts.send({ text }), fails("alerts_rate_limited", limited));
    const withoutSeconds: Record<string, string>[] = [
      {},
      { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    ];
    for (const headers of withoutSeconds) {
      channel.answerNext({ status: 429, headers });
      await assert.rejects(alerts.send({ text }), fails("alerts_rate_limited", { status: 429 }));
    }
  });

  it("a refused connection is alerts_unreachable", async () => {
    const closed = startedOn(await closedUrl(PATH));
    const refused = { reason: "network", code: "ECONNREFUSED" };
    await assert.rejects(closed.send({ text }), fails("alerts_unreachable", refused));
  });

  it("no answer within ALERTS_TIMEOUT_MS, 10 s, is alerts_unreachable", async (t) => {
    const asked: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    // The adapter's own timer, asked for 10 s, fires after 50 ms here.
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      asked.push(ms);
      return timeout(50);
    });
    channel.answerNext({ silent: true });
    await assert.rejects(alerts.send({ text }), fails("alerts_unreachable", { reason: "timeout" }));
    assert.deepEqual([ALERTS_TIMEOUT_MS, asked], [10_000, [10_000]]);
    await channel.closed();
  });

  it("an answer's body over 16 KiB is not read past 16 KiB: the adapter answers without waiting for more, and closes it", {
    timeout: 5_000,
  }, async (t) => {
    // No timer fires here: an adapter that read on would wait for good, and this test's 5 s fail it.
    t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
    assert.equal(ALERTS_ANSWER_MAX_BYTES, 16_384);
    channel.answerNext({ status: 200, openAfter: ALERTS_ANSWER_MAX_BYTES });
    assert.deepEqual(await alerts.send({ text }), {});
    channel.answerNext({ status: 400, openAfter: Number.POSITIVE_INFINITY });
    await assert.rejects(alerts.send({ text }), fails("alerts_rejected", { status: 400 }));
    await channel.closed();
  });

  it("the suite is skipped, never failed, while ALERTS_WEBHOOK_URL is empty", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/unset.ts", import.meta.url));
    // Without the test runner's own marker, or the child refuses to run a test file inside a test.
    const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
    const reporter = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
    const child = spawn(process.execPath, ["--test", ...reporter, fixture], {
      env: { ...env, ALERTS_WEBHOOK_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    assert.match(output, /﹣ skipped: no credentials \(ALERTS_WEBHOOK_URL\) .*# SKIP/);
    assert.match(output, /ℹ pass 0\n/);
    assert.match(output, /ℹ fail 0\n/);
    assert.match(output, /ℹ skipped 1\n/);
  });
});
