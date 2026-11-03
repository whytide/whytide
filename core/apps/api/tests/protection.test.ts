// The end-to-end test of alpha-p2-030 (docs/security.md): the host started as main.ts starts it, on
// the fake authentication adapter, a fixture module and the slice's Redis, answering real HTTP on
// 127.0.0.1 with APP_PUBLIC_ORIGIN set. The rate limits run on a clock the tests move, from a minute
// no earlier run used, and every test takes workspaces of its own. Run with `pnpm -F api test`.
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import v8 from "node:v8";
import vm from "node:vm";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");
const { securityHeaders } = await import("../src/protection/headers.ts");
const { WINDOW_MS } = await import("../src/protection/rate-limit.ts");
const { runs } = await import("./fixtures/protection/index.ts");

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;
const db = withTestDb();
const log = createLogger({ destination: collectLogs().destination });
const loader: ModuleLoader = {
  name: "protect",
  load: () => import("./fixtures/protection/index.ts"),
};
const MB = 1024 * 1024;
const base = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
let clock = base;
let api: Api;
let cookie: string;

/** One second into the n-th minute after the base. */
const minute = (n: number) => {
  clock = base + n * WINDOW_MS + 1_000;
};
/** The fixture route of a workspace no other test uses. */
const workspacePath = () => `/v1/workspaces/wsp_protect_${randomUUID().slice(0, 8)}/protect`;
const fromApp = () => ({ cookie, origin: APP_ORIGIN, "content-type": "application/json" });

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(new URL(path, api.url), { redirect: "manual", ...init });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? (JSON.parse(text) as unknown) : undefined,
  };
}

/** The statuses of `count` calls, ten at a time. */
async function statuses(count: number, path: string, init?: RequestInit): Promise<number[]> {
  const all: number[] = [];
  for (let done = 0; done < count; done += 10) {
    const batch = Array.from({ length: Math.min(10, count - done) }, () => call(path, init));
    all.push(...(await Promise.all(batch)).map(({ status }) => status));
  }
  return all;
}

/**
 * POSTs a JSON document of `total` bytes in 64 KB pieces, each written when the socket takes it, with
 * a Content-Length or chunked; resolves with the answer and the bytes that went before it.
 */
function post(path: string, total: number, chunked: boolean) {
  return new Promise<{ status: number; body: unknown; sent: number }>((resolve, reject) => {
    const length = chunked ? {} : { "content-length": String(total) };
    const req = request(new URL(path, api.url), {
      method: "POST",
      headers: { ...fromApp(), ...length },
    });
    const pieces = document(total);
    let sent = 0;
    let answered = false;
    req.on("response", (res: IncomingMessage) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined, sent });
      });
    });
    // The api closes the connection after a 413: writing then fails, the answer still comes.
    req.on("error", (error) => setTimeout(() => answered || reject(error), 200));
    const pump = () => {
      for (let piece = pieces.next(); !piece.done; piece = pieces.next()) {
        if (answered || req.destroyed) return;
        sent += piece.value.length;
        if (!req.write(piece.value)) return void req.once("drain", pump);
      }
      req.end();
    };
    pump();
  });
}

/** `{"pad":"aaa…"}`, `total` bytes long, from one 64 KB buffer. */
function* document(total: number): Generator<Buffer> {
  const [head, tail, pad] = [Buffer.from('{"pad":"'), Buffer.from('"}'), Buffer.alloc(65_536, "a")];
  yield head;
  for (let left = total - head.length - tail.length; left > 0; left -= pad.length) {
    yield pad.subarray(0, Math.min(pad.length, left));
  }
  yield tail;
}

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log,
    modules: [loader],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
    now: () => clock,
  });
  cookie = signInAs("usr_protect")
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
});
after(() => api?.close());

test("the 601st request of a minute for one workspace is 429 with Retry-After; another is not; the window slides", async () => {
  const [one, two] = [workspacePath(), workspacePath()];
  const member = { headers: { cookie } };
  minute(0);
  assert.deepEqual(new Set(await statuses(600, one, member)), new Set([200]));
  const limited = await call(one, member);
  assert.deepEqual([limited.status, limited.body], [429, { code: "rate_limited" }]);
  // The next request fits 100 ms into the next minute, when 599 of the 600 still count: in 59.1 s.
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal((await call(two, member)).status, 200);
  // One second into the next minute, 59/60 of the 600 still count: ten more pass, not 600.
  minute(1);
  assert.deepEqual(await statuses(11, one, member), [...Array(10).fill(200), 429]);
  // The authentication routes: 20 a minute per address; the fake answers a link's GET with 303.
  const auth = await statuses(21, "/api/auth/fake/verify?token=none");
  assert.deepEqual(auth, [...Array(20).fill(303), 429]);
});

test("a POST with the session cookie from another origin is 403 origin_rejected; from the app it passes; a GET is not checked", async () => {
  const path = workspacePath();
  const send = (headers: Record<string, string>) =>
    call(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", ...headers },
      body: "{}",
    });
  const elsewhere: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    {},
  ];
  for (const headers of elsewhere) {
    const refused = await send(headers);
    const answer = [refused.status, refused.body];
    assert.deepEqual(answer, [403, { code: "origin_rejected" }], JSON.stringify(headers));
  }
  assert.equal((await send({ origin: APP_ORIGIN })).status, 201);
  assert.equal((await send({ "sec-fetch-site": "same-origin" })).status, 201);
  const read = await call(path, { headers: { cookie, origin: "https://evil.example" } });
  assert.equal(read.status, 200);
});

test("every answer carries the security headers and no Server; /v1/ answers no-store and the policy too", async () => {
  minute(10);
  const path = workspacePath();
  const answers = {
    "/v1/ 200": await call(path, { headers: { cookie } }),
    "/v1/ 401": await call(path),
    "/v1/ 403": await call(path, { method: "POST", headers: { cookie } }),
    "/health/live": await call("/health/live"),
    "not found": await call("/nowhere"),
    "authentication handler": await call("/api/auth/fake/verify?token=none"),
  };
  for (const [name, { headers }] of Object.entries(answers)) {
    assert.equal(headers.get("x-content-type-options"), "nosniff", name);
    assert.equal(headers.get("referrer-policy"), "no-referrer", name);
    const permissions = "camera=(), microphone=(), geolocation=()";
    assert.equal(headers.get("permissions-policy"), permissions, name);
    assert.equal(headers.get("server"), null, name);
    assert.equal(
      headers.get("strict-transport-security"),
      null,
      `${name}: HSTS outside production`,
    );
    if (!name.startsWith("/v1/")) continue;
    assert.equal(headers.get("cache-control"), "no-store", name);
    const policy = "default-src 'none'; frame-ancestors 'none'";
    assert.equal(headers.get("content-security-policy"), policy, name);
  }
  // In production, HSTS as well.
  const set = new Map<string, unknown>();
  const res = { setHeader: (name: string, value: unknown) => set.set(name, value) };
  securityHeaders(true)(
    { url: "/" } as IncomingMessage,
    res as unknown as ServerResponse,
    () => {},
  );
  assert.equal(set.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
});

test("an @Idempotent() route answers a key once: the replay is the same, marked; another body is 422; no key is 400", async () => {
  const path = `${workspacePath()}/charges`;
  const workspace = path.split("/")[3] ?? "";
  const key = randomUUID();
  const charge = (body: unknown, headers: Record<string, string> = { "idempotency-key": key }) =>
    call(path, {
      method: "POST",
      headers: { ...fromApp(), ...headers },
      body: JSON.stringify(body),
    });
  const first = await charge({ amount: 5, currency: "EUR" });
  const replay = await charge({ currency: "EUR", amount: 5 });
  assert.equal(first.status, 201);
  assert.deepEqual([replay.status, replay.body], [first.status, first.body]);
  assert.equal(first.headers.get("idempotent-replayed"), null);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(runs.get(workspace), 1, "the handler ran once");
  const reused = await charge({ amount: 6, currency: "EUR" });
  assert.deepEqual(
    [reused.status, (reused.body as { code: string }).code],
    [422, "idempotency_key_reused"],
  );
  const missing = await charge({ amount: 5, currency: "EUR" }, {});
  assert.deepEqual([missing.status, missing.body], [400, { code: "idempotency_key_required" }]);
  assert.equal(runs.get(workspace), 1);
});

test("a 2 MB JSON body is 413 payload_too_large; a 20 MB one is not read past the limit", async () => {
  const path = workspacePath();
  const declared = await post(path, 2 * MB, false);
  assert.deepEqual([declared.status, declared.body], [413, { code: "payload_too_large" }]);
  const ownLimit = await post(`${path}/imports`, 2 * MB, false);
  assert.deepEqual([ownLimit.status, ownLimit.body], [201, { bytes: 2 * MB - 10 }]);

  gc();
  const memory = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const start = memory();
  let peak = start;
  const sampler = setInterval(() => {
    peak = Math.max(peak, memory());
  }, 2);
  const streamed = await post(path, 20 * MB, true).finally(() => clearInterval(sampler));
  peak = Math.max(peak, memory());
  assert.deepEqual([streamed.status, streamed.body], [413, { code: "payload_too_large" }]);
  assert.ok(streamed.sent < 20 * MB, `all ${streamed.sent} bytes went: the api read them`);
  assert.ok(peak - start < 10 * MB, `the memory grew by ${peak - start} bytes`);

  const multipart = await call(path, {
    method: "POST",
    headers: { ...fromApp(), "content-type": "multipart/form-data; boundary=b" },
    body: "--b--",
  });
  assert.equal(multipart.status, 415, "multipart on a route that does not declare it");
});
