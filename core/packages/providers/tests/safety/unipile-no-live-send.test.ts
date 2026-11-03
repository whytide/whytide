// A safety case of beta-p0-030 (beta: no test sends from a real account; the owner's live run alone
// sends, between two accounts the owner names): the gate of the Unipile live suite's send cases,
// linkedin/unipile/tests/live.ts. Only all three of UNIPILE_TEST_ACCOUNT_ID (the sender),
// UNIPILE_TEST_RECIPIENT_PROVIDER_ID (the recipient) and UNIPILE_LIVE_SENDS=1 open it, never under
// APP_ENV=production, where the suite refuses to start. Without the gate the world has no recipient,
// and linkedin/contract.ts skips each send case without one; with it, the recipient goes to the
// sender the gate names only. The suite itself runs in a child process whose every request, to any
// host, goes through a local counter instead (NODE_USE_ENV_PROXY): with the adapter's variables but
// no UNIPILE_TEST_* variable it sees none; with the read variables it sees the reads, and the send
// cases skip.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { liveSendGate, unipileWorld } from "../../linkedin/unipile/tests/live.ts";

const SEND = {
  UNIPILE_TEST_ACCOUNT_ID: "fixture-sender-account",
  UNIPILE_TEST_RECIPIENT_PROVIDER_ID: "fixture-recipient-member",
  UNIPILE_LIVE_SENDS: "1",
} as const;
const READ = {
  UNIPILE_TEST_POST_URL:
    "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
  UNIPILE_TEST_PROFILE_URL: "https://www.linkedin.com/in/ada-example/",
};
const OPENED = {
  accountRef: SEND.UNIPILE_TEST_ACCOUNT_ID,
  recipientRef: SEND.UNIPILE_TEST_RECIPIENT_PROVIDER_ID,
};
const SUITE = fileURLToPath(
  new URL("../../linkedin/unipile/tests/contract.test.ts", import.meta.url),
);
/** What the parent's environment must not pass on: its own Unipile, proxy and test-runner settings. */
const INHERITED = /^(UNIPILE_|NODE_TEST_CONTEXT$|NODE_USE_ENV_PROXY$)|_PROXY$/i;

/** Every subset of the three send variables, with whether it is all three. */
const subsets = () =>
  Array.from({ length: 8 }, (_, mask) => {
    const names = Object.keys(SEND).filter((_, bit) => mask & (1 << bit));
    const env = Object.fromEntries(names.map((name) => [name, SEND[name as keyof typeof SEND]]));
    return { env, all: names.length === 3 };
  });

test("the send gate opens with all three variables only, UNIPILE_LIVE_SENDS exactly 1", () => {
  for (const { env, all } of subsets()) {
    const gate = liveSendGate({ ...env, APP_ENV: "test" });
    assert.deepEqual(gate, all ? OPENED : undefined, JSON.stringify(env));
  }
  for (const value of ["", "0", "true", "yes", " 1", "1 ", "01"]) {
    assert.equal(liveSendGate({ ...SEND, UNIPILE_LIVE_SENDS: value }), undefined, `"${value}"`);
  }
  for (const name of ["UNIPILE_TEST_ACCOUNT_ID", "UNIPILE_TEST_RECIPIENT_PROVIDER_ID"]) {
    assert.equal(liveSendGate({ ...SEND, [name]: "" }), undefined, `${name} empty`);
  }
});

test("with the adapter's and the read suite's variables but not all three, the world has no recipient: no send case runs", async () => {
  const counter = await requestCounter();
  for (const { env, all } of subsets()) {
    const world = unipileWorld({ ...adapterEnv(counter.port), ...READ, ...env, APP_ENV: "test" });
    assert.equal(typeof world.recipient, all ? "function" : "undefined", JSON.stringify(env));
  }
  // The recipient goes to the sender the gate names, never to an account the suite found itself.
  const world = unipileWorld({ ...adapterEnv(counter.port), ...SEND, APP_ENV: "test" });
  await assert.rejects(
    world.recipient?.("another-account") ?? Promise.resolve(),
    /UNIPILE_TEST_ACCOUNT_ID/,
  );
  // The live suite end to end: the reads reach the counter, never a vendor; both send cases skip.
  const run = await runSuite({ ...adapterEnv(counter.port), ...READ, APP_ENV: "test" });
  counter.close();
  assert.ok(counter.seen() > 0, `the reads ran, through the counter\n${run.output}`);
  assert.match(run.output, /﹣ sendInvite leaves an invitation pending.*# no member to invite/);
  assert.match(run.output, /﹣ sendMessage to a relation.*# no relation to message/);
});

test("under APP_ENV=production the gate refuses, and the live suite refuses to start with no request", async () => {
  assert.throws(() => liveSendGate({ ...SEND, APP_ENV: "production" }), /APP_ENV=production/);
  const counter = await requestCounter();
  const env = { ...adapterEnv(counter.port), ...READ, ...SEND, APP_ENV: "production" };
  const run = await runSuite(env);
  counter.close();
  assert.notEqual(run.code, 0, run.output);
  assert.match(run.output, /live send cases are refused under APP_ENV=production/);
  assert.equal(counter.seen(), 0, run.output);
});

test("a run with the adapter's variables but no UNIPILE_TEST_* variable makes no request", async () => {
  const counter = await requestCounter();
  const run = await runSuite({
    ...adapterEnv(counter.port),
    UNIPILE_LIVE_SENDS: "1",
    APP_ENV: "test",
  });
  counter.close();
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /﹣ skipped: no UNIPILE_TEST_\* variable/);
  assert.equal(counter.seen(), 0, run.output);
});

/** A TCP listener on 127.0.0.1 that counts every connection and closes it at once. */
async function requestCounter() {
  let seen = 0;
  const server = createServer((socket) => {
    seen += 1;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { port, seen: () => seen, close: () => server.close() };
}

/**
 * The adapter's own variables, made up for the run, its address the counter's; and a proxy for every
 * request of the child, to any host, which is the counter too: nothing it sends leaves the machine.
 */
function adapterEnv(port: number): Record<string, string> {
  const counter = `http://127.0.0.1:${port}`;
  return {
    UNIPILE_BASE_URL: `https://127.0.0.1:${port}`,
    UNIPILE_API_KEY: randomBytes(24).toString("base64url"),
    UNIPILE_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    UNIPILE_CURSOR_SECRET: randomBytes(32).toString("hex"),
    UNIPILE_NOTIFY_URL: "https://api.whytide.test/v1/linkedin/webhooks/unipile",
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: counter,
    HTTP_PROXY: counter,
    NO_PROXY: "",
  };
}

/** The live suite, contract.test.ts, through `node --test` in a child process with `env` only added. */
async function runSuite(env: Record<string, string>) {
  const inherited = Object.entries(process.env).filter(([name]) => !INHERITED.test(name));
  const reporter = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
  const child = spawn(process.execPath, ["--test", ...reporter, SUITE], {
    env: { ...Object.fromEntries(inherited), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, output };
}
