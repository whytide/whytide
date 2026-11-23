// The tests of `pnpm unipile:webhooks` (scripts/unipile-webhooks.ts), run as an operator runs it,
// in a child process, against a fake Unipile on 127.0.0.1 that this file starts: never Unipile
// itself. The script runs from a copy of its folder in a temporary root, so that no run can read
// the worktree's .env.local; every env file is written here, its key and secrets made at random at
// each run, and every run's output is scanned for them and for the fake's error text.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { deployDir } from "./env-fixture.ts";

type Header = { key: string; value: string };
type Hook = {
  id: string;
  source: string;
  name: string;
  request_url: string;
  format: string;
  events: string[];
  headers: Header[];
};
type Seen = { method: string; path: string; key: string };
type Fake = Awaited<ReturnType<typeof fakeUnipile>>;

const tmp = join(deployDir, "..", ".tmp");
const SCRIPTS = ["unipile-webhooks.ts", "deploy-check.ts", "constants.ts"];
const NOTIFY = "https://whytide.example.com/v1/linkedin/webhooks/unipile";
/** The most webhooks a page of the fake's list holds, so that a listing reads several pages. */
const FAKE_PAGE = 2;
/** The fake's 401 body, which no run may print but its status and type. */
const ERROR_TITLE = "Missing credentials";
const ERROR_DETAIL = "fake-unipile-detail-text";
const ACCOUNT_STATUS_EVENTS = [
  ...["ok", "reconnected", "creation_success", "sync_success", "credentials", "error"],
  ...["stopped", "deleted", "connecting", "creation_fail", "permissions"],
];
const SOURCES = [
  { source: "messaging", events: ["message_received"] },
  { source: "users", events: ["new_relation"] },
  { source: "account_status", events: ACCOUNT_STATUS_EVENTS },
];

let work = "";
let root = "";
let script = "";
let files = 0;
let fake: Fake;
let good: Record<string, string>;

/** Every key and secret this file makes: no run's output may hold one. */
const secrets = new Set<string>();
function secret(chars = 64): string {
  const value = randomBytes(chars).toString("hex").slice(0, chars);
  secrets.add(value);
  return value;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Unipile's webhooks routes, the list in pages of FAKE_PAGE; 401 for a key it does not hold. A
 * webhook keeps the `source` its POST sent, which Unipile's list leaves out, as the fake's does.
 */
async function fakeUnipile() {
  const state = {
    hooks: [] as Hook[],
    seen: [] as Seen[],
    keys: new Set<string>(),
    redirectTo: undefined as string | undefined,
  };
  let next = 1;
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = String(request.headers["x-api-key"] ?? "");
    state.seen.push({ method: request.method ?? "", path: url.pathname, key });
    const send = (status: number, json?: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(json === undefined ? "" : JSON.stringify(json));
    };
    const notFound = () => send(404, { status: 404, type: "errors/resource_not_found" });
    if (state.redirectTo !== undefined) return send(302, undefined, { location: state.redirectTo });
    if (!state.keys.has(key)) {
      const type = "errors/missing_credentials";
      return send(401, { status: 401, type, title: ERROR_TITLE, detail: ERROR_DETAIL });
    }
    if (url.pathname === "/api/v1/webhooks" && request.method === "GET") {
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const end = start + Math.min(Number(url.searchParams.get("limit")), FAKE_PAGE);
      const items = state.hooks
        .slice(start, end)
        .map(({ source: _, ...hook }) => ({ object: "Webhook", ...hook }));
      const cursor = end < state.hooks.length ? String(end) : null;
      return send(200, { object: "WebhookList", items, cursor });
    }
    if (url.pathname === "/api/v1/webhooks" && request.method === "POST") {
      const hook = { id: `wh_${next++}`, ...JSON.parse(body) } as Hook;
      state.hooks.push(hook);
      return send(201, { object: "WebhookCreated", webhook_id: hook.id });
    }
    const id = /^\/api\/v1\/webhooks\/([^/]+)$/.exec(url.pathname)?.[1];
    const at = state.hooks.findIndex((hook) => hook.id === decodeURIComponent(id ?? ""));
    if (request.method !== "DELETE" || at < 0) return notFound();
    state.hooks.splice(at, 1);
    return send(200, { object: "WebhookDeleted" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stop = () => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { state, url: `http://127.0.0.1:${port}`, stop };
}

/** A webhook another tool registered on the same Unipile account, with a header of its own. */
const otherHook = (): Hook => ({
  id: "wh_crm",
  source: "messaging",
  name: "crm-messaging",
  request_url: "https://crm.example.com/hooks/unipile",
  format: "json",
  events: ["message_received"],
  headers: [{ key: "X-Crm-Auth", value: secret() }],
});
/** One of ours from before: an old tunnel's address and an old secret. */
const staleHook = (source: string, id: string): Hook => ({
  id,
  source,
  name: `whytide-${source}`,
  request_url: "https://old-tunnel.example.com/v1/linkedin/webhooks/unipile",
  format: "json",
  events: source === "messaging" ? ["message_received"] : ["ok", "credentials", "error"],
  headers: [{ key: "Unipile-Auth", value: secret() }],
});
const ours = () => fake.state.hooks.filter(({ name }) => name.startsWith("whytide-"));
const theirs = () => fake.state.hooks.filter(({ name }) => !name.startsWith("whytide-"));
const line = ({ id, name, request_url }: Hook) => `  ${id}  ${name}  ${request_url}\n`;

/** An env file as an operator writes one: quoted values, then `# secret`; none for undefined. */
function envFile(values: Record<string, string | undefined>, at?: string): string {
  const file = at ?? join(work, `env-${++files}`);
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}="${value}" # secret`);
  fs.writeFileSync(file, `# ---- linkedin ----\n${lines.join("\n")}\n`);
  return file;
}

/** The script in a child process, from the copy's root: its exit, its output, scanned. */
async function run(args: string[], options: { testHttp?: boolean } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (options.testHttp !== false) env.UNIPILE_WEBHOOKS_TEST_HTTP = "1";
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    err += chunk;
  });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const all = out + err;
  for (const value of secrets) assert.ok(!all.includes(value), "a key or a secret in the output");
  for (const text of [ERROR_TITLE, ERROR_DETAIL, "Unipile-Auth", "X-Crm-Auth"]) {
    assert.ok(!all.includes(text), `${text} in the output`);
  }
  return { status, out, err };
}

before(() => {
  fs.mkdirSync(tmp, { recursive: true });
  work = fs.mkdtempSync(join(tmp, "unipile-webhooks-"));
  root = join(work, "root");
  const scripts = join(root, "deploy", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of SCRIPTS) {
    fs.copyFileSync(join(deployDir, "scripts", name), join(scripts, name));
  }
  fs.writeFileSync(join(root, "deploy", "package.json"), '{ "type": "module" }\n');
  script = join(scripts, "unipile-webhooks.ts");
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

beforeEach(async () => {
  fake = await fakeUnipile();
  const key = secret();
  fake.state.keys.add(key);
  good = {
    PROVIDER_LINKEDIN: "unipile",
    UNIPILE_BASE_URL: fake.url,
    UNIPILE_API_KEY: key,
    UNIPILE_WEBHOOK_SECRET: secret(),
    UNIPILE_NOTIFY_URL: NOTIFY,
    UNIPILE_CURSOR_SECRET: secret(),
  };
});
afterEach(() => fake.stop());

test("register replaces the three whytide-* webhooks, keeps every other, and leaves exactly three when run again", async () => {
  const other = otherHook();
  fake.state.hooks.push(
    other,
    staleHook("messaging", "wh_old1"),
    staleHook("account_status", "wh_old2"),
  );
  const file = envFile(good);
  // Each POST's body, its source included, which Unipile's list leaves out.
  const expected = SOURCES.map(({ source, events }) => ({
    source,
    name: `whytide-${source}`,
    request_url: NOTIFY,
    format: "json",
    events,
    headers: [{ key: "Unipile-Auth", value: good.UNIPILE_WEBHOOK_SECRET }],
  }));
  for (const round of [1, 2]) {
    const { status, out } = await run(["register", "--env-file", file]);
    assert.equal(status, 0, `round ${round}`);
    assert.deepEqual(
      ours().map(({ id: _, ...hook }) => hook),
      expected,
    );
    assert.deepEqual(theirs(), [other]);
    for (const hook of ours()) assert.ok(out.includes(line(hook)), `${hook.name} listed`);
    if (round === 1) {
      assert.match(out, /removed whytide-messaging \(wh_old1\)\n/);
      assert.match(out, /removed whytide-account_status \(wh_old2\)\n/);
      assert.doesNotMatch(out, /removed crm-messaging/);
    }
  }
  assert.equal(fake.state.hooks.length, 4);
  // Every request went to the webhooks route, with the key in X-API-KEY.
  for (const seen of fake.state.seen) {
    assert.equal(seen.key, good.UNIPILE_API_KEY);
    assert.match(seen.path, /^\/api\/v1\/webhooks(?:\/[^/]+)?$/);
  }
});

test("remove removes the three whytide-* webhooks and no other, another whytide-* name included", async () => {
  const other = otherHook();
  const legacy = { ...staleHook("messaging", "wh_legacy"), name: "whytide-legacy" };
  fake.state.hooks.push(other, legacy);
  const file = envFile(good);
  assert.equal((await run(["register", "--env-file", file])).status, 0);
  assert.equal(ours().length, 4);
  const removed = await run(["remove", "--env-file", file]);
  assert.equal(removed.status, 0);
  assert.deepEqual(fake.state.hooks, [other, legacy]);
  const again = await run(["remove", "--env-file", file]);
  assert.equal(again.status, 0);
  assert.match(again.out, /no whytide-\* webhook of the three to remove/);
  assert.deepEqual(fake.state.hooks, [other, legacy]);
});

test("list prints each webhook's id, name and URL, never a header or a secret", async () => {
  fake.state.hooks.push(otherHook(), staleHook("users", "wh_old3"));
  const file = envFile(good);
  assert.equal((await run(["register", "--env-file", file])).status, 0);
  const { status, out } = await run(["list", "--env-file", file]);
  assert.equal(status, 0);
  assert.match(out, /4 webhooks: id, name, URL\n/);
  for (const hook of fake.state.hooks) assert.ok(out.includes(line(hook)), hook.name);
  // run() has found no header's name or value, no key and no secret in the output.
});

test("check answers fine on a good file with GETs only, and counts the whytide-* webhooks with their URLs", async () => {
  const file = envFile(good);
  const before = await run(["check", "--env-file", file]);
  assert.equal(before.status, 0);
  for (const key of Object.keys(good).filter((key) => key.startsWith("UNIPILE_"))) {
    assert.match(before.out, new RegExp(`ok: ${key} `));
  }
  assert.match(before.out, /Unipile lists 0 webhooks\nunipile:webhooks: 0 whytide-\* webhooks/);
  assert.match(before.err, /warning: not once at UNIPILE_NOTIFY_URL: .*: run register/);
  assert.deepEqual(new Set(fake.state.seen.map(({ method }) => method)), new Set(["GET"]));

  fake.state.hooks.push(otherHook());
  assert.equal((await run(["register", "--env-file", file])).status, 0);
  const after = await run(["check", "--env-file", file]);
  assert.equal(after.status, 0);
  assert.equal(after.err, "");
  assert.match(after.out, /Unipile lists 4 webhooks/);
  assert.match(after.out, /3 whytide-\* webhooks/);
  for (const hook of ours()) assert.ok(after.out.includes(line(hook)), hook.name);
  assert.ok(!after.out.includes("crm-messaging"));

  const fakeAdapter = await run([
    "check",
    "--env-file",
    envFile({ ...good, PROVIDER_LINKEDIN: "fake" }),
  ]);
  assert.equal(fakeAdapter.status, 0);
  assert.match(fakeAdapter.err, /warning: PROVIDER_LINKEDIN is not unipile/);
});

test("check names each bad value with exit 1, and nothing is sent to Unipile", async () => {
  const short = secret(31);
  const cases: [Record<string, string | undefined>, string][] = [
    [{ UNIPILE_API_KEY: undefined }, "UNIPILE_API_KEY is missing"],
    [{ UNIPILE_BASE_URL: "http://unipile.example.com:13443" }, "UNIPILE_BASE_URL is not an https"],
    [{ UNIPILE_BASE_URL: undefined }, "UNIPILE_BASE_URL is missing"],
    [{ UNIPILE_WEBHOOK_SECRET: short }, "UNIPILE_WEBHOOK_SECRET is shorter than 32 characters"],
    [{ UNIPILE_CURSOR_SECRET: short }, "UNIPILE_CURSOR_SECRET is shorter than 32 characters"],
    [{ UNIPILE_CURSOR_SECRET: undefined }, "UNIPILE_CURSOR_SECRET is missing"],
    [
      { UNIPILE_NOTIFY_URL: "https://whytide.example.com/v1/linkedin/webhooks" },
      "UNIPILE_NOTIFY_URL has a path not ending in /v1/linkedin/webhooks/unipile",
    ],
    [
      { UNIPILE_NOTIFY_URL: NOTIFY.replace("https:", "http:") },
      "UNIPILE_NOTIFY_URL is not an https",
    ],
  ];
  for (const [values, finding] of cases) {
    const { status, err } = await run(["check", "--env-file", envFile({ ...good, ...values })]);
    assert.equal(status, 1, finding);
    assert.ok(err.includes(`wrong: ${finding}`), finding);
    assert.match(err, /nothing was sent to Unipile/);
  }
  // The fake's own http address, without the tests' switch; and register, which checks first too.
  const local = await run(["check", "--env-file", envFile(good)], { testHttp: false });
  assert.equal(local.status, 1);
  assert.match(local.err, /wrong: UNIPILE_BASE_URL is not an https address/);
  const register = await run([
    "register",
    "--env-file",
    envFile({ ...good, UNIPILE_WEBHOOK_SECRET: short }),
  ]);
  assert.equal(register.status, 1);
  assert.deepEqual(fake.state.seen, []);
});

test("an unknown command, an unknown option, a second command or none is a usage error, exit 2; --help is the usage, exit 0", async () => {
  for (const args of [
    ["bogus"],
    ["list", "--verbose"],
    ["list", "remove"],
    ["list", "--env-file"],
    [],
  ]) {
    const { status, out, err } = await run(args);
    assert.equal(status, 2, args.join(" "));
    assert.match(err, /Usage: pnpm unipile:webhooks <command> \[--env-file <path>\]/);
    assert.doesNotMatch(out + err, /: read /);
  }
  const help = await run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.out, /Usage: pnpm unipile:webhooks/);
  assert.deepEqual(fake.state.seen, []);
});

test("the env file is --env-file, else .env.local at the repository root, else deploy/.env", async () => {
  const keys = [secret(), secret(), secret()];
  for (const key of keys) fake.state.keys.add(key);
  const keyOfLastCall = () => fake.state.seen.at(-1)?.key;
  const written = [
    join(root, "deploy", ".env"),
    join(root, ".env.local"),
    join(root, "custom.env"),
  ];
  try {
    envFile({ ...good, UNIPILE_API_KEY: keys[0] }, written[0]);
    const deployEnv = await run(["list"]);
    assert.equal(deployEnv.status, 0);
    assert.match(deployEnv.out, /: read deploy\/\.env\n/);
    assert.equal(keyOfLastCall(), keys[0]);

    envFile({ ...good, UNIPILE_API_KEY: keys[1] }, written[1]);
    const local = await run(["list"]);
    assert.equal(local.status, 0);
    assert.match(local.out, /: read \.env\.local\n/);
    assert.equal(keyOfLastCall(), keys[1]);

    envFile({ ...good, UNIPILE_API_KEY: keys[2] }, written[2]);
    const given = await run(["list", "--env-file", "custom.env"]);
    assert.equal(given.status, 0);
    assert.match(given.out, /: read custom\.env\n/);
    assert.equal(keyOfLastCall(), keys[2]);
  } finally {
    for (const file of written) fs.rmSync(file, { force: true });
  }
});

test("a 401 prints the status and Unipile's error type only, with exit 1, and register then changes nothing", async () => {
  const wrongKey = envFile({ ...good, UNIPILE_API_KEY: secret() });
  const listed = await run(["list", "--env-file", wrongKey]);
  assert.equal(listed.status, 1);
  assert.match(
    listed.err,
    /GET \/api\/v1\/webhooks: Unipile answered 401 errors\/missing_credentials\n$/,
  );
  fake.state.hooks.push(staleHook("messaging", "wh_old1"));
  const registered = await run(["register", "--env-file", wrongKey]);
  assert.equal(registered.status, 1);
  assert.deepEqual(
    ours().map(({ id }) => id),
    ["wh_old1"],
  );
  // run() has found neither the body's title nor its detail in the output.
});

test("a redirect is never followed: the key stays with UNIPILE_BASE_URL", async () => {
  const elsewhere = await fakeUnipile();
  try {
    elsewhere.state.keys.add(good.UNIPILE_API_KEY ?? "");
    fake.state.redirectTo = `${elsewhere.url}/api/v1/webhooks`;
    const { status, err } = await run(["list", "--env-file", envFile(good)]);
    assert.equal(status, 1);
    assert.match(err, /Unipile answered 302, a redirect, not followed/);
    assert.deepEqual(elsewhere.state.seen, []);
  } finally {
    await elsewhere.stop();
  }
});
