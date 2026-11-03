// Unit tests of logging (alpha-p1-030): the redaction of person fields at any depth, the log-schema
// check on allowed keys and PII-shaped values, and the committed log-schema.json mirroring the code;
// and what a line keeps of an error, wherever it sits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { AppError } from "../errors/index.ts";
import { checkLogLines, createLogger, logSchema, withLogContext } from "../logging/index.ts";
import { collectLogs, type SyntheticPerson, synthetic } from "../testing/index.ts";

/** The person as the line shows it: the personal fields redacted, the company (business data) kept. */
const redacted = (person: SyntheticPerson) => ({
  first_name: "[redacted]",
  last_name: "[redacted]",
  email: "[redacted]",
  linkedin_url: "[redacted]",
  company: person.company,
});

test("a person's fields are redacted at the top level, nested, in arrays and in camelCase", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination, level: "debug" });
  const person = synthetic("logging").person();
  log.info({ ...person, lead_count: 1 }, "top level");
  log.info({ person, batch: { people: [person] } }, "nested");
  log.warn(
    { firstName: "Ada", linkedinUrl: "https://www.linkedin.com/in/x", authorization: "Bearer x" },
    "camel",
  );
  const [top, nested, camel] = logs.lines();
  assert.ok(top && nested && camel);
  assert.deepEqual(
    { ...top, time: 0, pid: 0, hostname: "" },
    {
      level: "info",
      time: 0,
      pid: 0,
      hostname: "",
      ...redacted(person),
      lead_count: 1,
      msg: "top level",
    },
  );
  assert.deepEqual(nested.person, redacted(person));
  assert.deepEqual(nested.batch, { people: [redacted(person)] });
  assert.deepEqual(camel, {
    ...camel,
    firstName: "[redacted]",
    linkedinUrl: "[redacted]",
    authorization: "[redacted]",
  });
});

test("the context's workspace_id and actor appear only while set", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  withLogContext({ workspace_id: "wsp_a", actor: "usr_b" }, () => log.info("inside"));
  log.info("outside");
  const [inside, outside] = logs.lines();
  assert.equal(inside?.workspace_id, "wsp_a");
  assert.equal(inside?.actor, "usr_b");
  assert.equal(outside?.workspace_id, undefined);
  assert.equal(outside?.actor, undefined);
});

test("the log-schema check allows only the listed keys and no PII-shaped value", () => {
  const good = JSON.stringify({
    level: "info",
    time: 1,
    pid: 1,
    hostname: "h",
    trace_id: "0af7651916cd43dd8448eb211c80319c",
    workspace_id: "wsp_x",
    lead_count: 3,
    duration_ms: 12,
    err: { type: "AppError", message: "icp_not_found", code: "icp_not_found", status: 404 },
    msg: "qualified",
  });
  assert.deepEqual(checkLogLines([good]), []);
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ level: "info", time: 1, msg: "m", ...fields });
  assert.match(
    checkLogLines([line({ msg: "sent to jane.fixture@example.com" })]).join(),
    /line 1.*msg.*email/,
  );
  assert.match(
    checkLogLines([
      line({ details: { note: "https://www.linkedin.com/in/fixture-person-1" } }),
    ]).join(),
    /details\.note.*LinkedIn/,
  );
  assert.match(
    checkLogLines([
      line({ msg: `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}` }),
    ]).join(),
    /token/,
  );
  assert.match(
    checkLogLines([line({ details: { note: "Bearer abcdefghijklmnopqrstuvwxyz" } })]).join(),
    /token/,
  );
  assert.match(
    checkLogLines([line({ person: { first_name: "[redacted]" } })]).join(),
    /"person".*not allowed.*"person\.first_name".*not allowed/s,
  );
  assert.match(checkLogLines(["not json"]).join(), /line 1.*not JSON/);
});

test("log-schema.json mirrors the schema in code, for the secrets:scan check", () => {
  const json = JSON.parse(
    readFileSync(new URL("../logging/log-schema.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(json, logSchema);
});

test("a key ending in _ref, _token or _secret and any binary value are redacted, at any depth", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  const blob = Buffer.from("v1 not a real blob");
  log.info(
    {
      account_ref: "acc_7f3e",
      oauthToken: "t",
      webhook_secret: "s",
      blob,
      ref_count: 2,
      deep: { l1: { l2: { l3_ref: "x", bytes: new Uint8Array(2), l3: { l4_ref: "kept" } } } },
      list: [{ api_token: "t", keys: [blob] }],
      when: new Date(0),
      err: Object.assign(new Error("boom"), { code: "boom_failed" }),
    },
    "stored",
  );
  log.info(blob, "raw");
  const [line, raw] = logs.lines();
  assert.ok(line && raw);
  assert.deepEqual(
    {
      account_ref: line.account_ref,
      oauthToken: line.oauthToken,
      webhook_secret: line.webhook_secret,
      blob: line.blob,
      ref_count: line.ref_count,
      deep: line.deep,
      list: line.list,
      when: line.when,
    },
    {
      account_ref: "[redacted]",
      oauthToken: "[redacted]",
      webhook_secret: "[redacted]",
      blob: "[redacted]",
      ref_count: 2,
      deep: { l1: { l2: { l3_ref: "[redacted]", bytes: "[redacted]", l3: { l4_ref: "kept" } } } },
      list: [{ api_token: "[redacted]", keys: ["[redacted]"] }],
      when: "1970-01-01T00:00:00.000Z",
    },
  );
  // Not an AppError: its type, its code and its stack's frames, never its message.
  const err = line.err as { type: string; message?: string; stack: string; code: string };
  assert.deepEqual([err.type, err.code, err.message], ["Error", "boom_failed", undefined]);
  assert.match(err.stack, /^ {4}at /);
  assert.equal(raw.binary, "[redacted]");
  assert.equal(JSON.stringify(raw).includes('"0"'), false);
  assert.ok(!logs.raw.join().includes("not a real blob"));
});

test("child bindings, an error's details, a nested error and a class instance are walked too", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  const blob = Buffer.from("v1 not a real blob");
  class Dto {
    providerAccountRef = "acc_7f3e";
    providerId = "prv_1";
  }
  const failed = new AppError("sender_failed", {
    details: { provider_account_ref: "acc_7f3e", blob, sender_account_id: "snd_1" },
  });
  log.child({ account_ref: "acc_7f3e", blob, request_id: "req_1" }).info("from a child");
  log.child({ a: 1 }).child({ oauth_token: "t" }).info("from a grandchild");
  const bound = log.child({ request_id: "req_2" });
  bound.setBindings({ api_token: "X", blob });
  bound.info("after setBindings");
  log.error({ err: failed, dto: new Dto(), failure: { err: failed }, at: new Date(0) }, "failed");
  log.error(failed);
  const [child, grandchild, set, line, bare] = logs.lines();
  assert.ok(child && grandchild && set && line && bare);
  assert.deepEqual(
    { account_ref: child.account_ref, blob: child.blob, request_id: child.request_id },
    { account_ref: "[redacted]", blob: "[redacted]", request_id: "req_1" },
  );
  assert.deepEqual(
    { a: grandchild.a, oauth_token: grandchild.oauth_token },
    { a: 1, oauth_token: "[redacted]" },
  );
  assert.deepEqual(
    { request_id: set.request_id, api_token: set.api_token, blob: set.blob },
    { request_id: "req_2", api_token: "[redacted]", blob: "[redacted]" },
  );
  const err = line.err as Record<string, unknown>;
  assert.equal(err.type, "AppError");
  assert.equal(err.message, "sender_failed");
  assert.equal(err.code, "sender_failed");
  assert.match(String(err.stack), /sender_failed/);
  assert.deepEqual(err.details, {
    provider_account_ref: "[redacted]",
    blob: "[redacted]",
    sender_account_id: "snd_1",
  });
  assert.deepEqual(line.dto, { providerAccountRef: "[redacted]", providerId: "prv_1" });
  assert.deepEqual(line.failure, {
    err: {
      type: "AppError",
      code: "sender_failed",
      status: 500,
      details: {
        provider_account_ref: "[redacted]",
        blob: "[redacted]",
        sender_account_id: "snd_1",
      },
    },
  });
  assert.equal(line.at, "1970-01-01T00:00:00.000Z");
  assert.equal((bare.err as Record<string, unknown>).code, "sender_failed");
  assert.deepEqual((bare.err as { details: unknown }).details, {
    provider_account_ref: "[redacted]",
    blob: "[redacted]",
    sender_account_id: "snd_1",
  });
  assert.ok(!logs.raw.join().includes("acc_7f3e"));
  assert.ok(!logs.raw.join().includes("not a real blob"));
});

test("an err.stack with pnpm paths is not an email; real addresses still are", () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ level: "error", time: 1, msg: "m", ...fields });
  const stack = [
    "Error: boom",
    "    at file:///w/node_modules/.pnpm/@opentelemetry+api@1.9.1/node_modules/@opentelemetry/api/build/src/trace.js:12:5",
    "    at file:///w/node_modules/.pnpm/pino@10.4.0/node_modules/pino/lib/proto.js:230:7",
    "    at node:internal/main/run_main_module:36:49",
  ].join("\n");
  assert.deepEqual(checkLogLines([line({ err: { type: "Error", message: "boom", stack } })]), []);
  for (const address of [
    "ada.example@example.com",
    "ada+tag@mail.example.co.uk",
    "ADA@EXAMPLE.ORG",
    "a@b.io",
  ]) {
    assert.match(checkLogLines([line({ msg: `sent to ${address}` })]).join(), /msg.*email/);
  }
  assert.match(checkLogLines([line({ msg: "sent to jane@example.com." })]).join(), /msg.*email/);
  assert.deepEqual(checkLogLines([line({ msg: "ref jane@example.com123" })]), []);
});

test("a logged AppError's cause writes its type and code only: no message, stack or payload", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  // A vendor SDK's error: a message and a payload with a person and a token, and a toJSON.
  class VendorError extends Error {
    payload = { email: "jane.fixture@example.com", token: "cause-secret-1" };
    toJSON() {
      return { message: this.message, payload: this.payload };
    }
  }
  const socket = Object.assign(new Error("connect ECONNRESET cause-secret-2"), {
    code: "ECONNRESET",
  });
  const vendor = new VendorError("401 for cause-secret-3", { cause: socket });
  const deep = [1, 2, 3, 4].reduce<Error>(
    (c, n) => new Error(`cause-secret-${n}`, { cause: c }),
    vendor,
  );
  const assigned = new AppError("sender_failed");
  assigned.cause = vendor; // enumerable, unlike the constructor's
  log.error({ err: new AppError("sender_failed", { cause: vendor }) }, "top level");
  log.error({ err: assigned }, "assigned");
  log.error({ failure: { err: new AppError("sender_failed", { cause: vendor }) }, error: vendor });
  log.error(new AppError("sender_failed", { cause: deep }));
  const [top, own, nested, bare] = logs.lines();
  assert.ok(top && own && nested && bare);
  assert.doesNotMatch(logs.raw.join(), /cause-secret|jane\.fixture|caused by/);
  const socketCause = { type: "Error", code: "ECONNRESET" };
  const vendorCause = { type: "VendorError", cause: socketCause };
  assert.deepEqual((top.err as { cause: unknown }).cause, vendorCause);
  assert.deepEqual((own.err as { cause: unknown }).cause, vendorCause);
  assert.deepEqual(nested.failure, {
    err: { type: "AppError", code: "sender_failed", status: 500, cause: vendorCause },
  });
  assert.deepEqual(nested.error, { type: "VendorError", cause: socketCause });
  // Three levels of cause, the deeper ones dropped.
  assert.deepEqual((bare.err as { cause: unknown }).cause, {
    type: "Error",
    cause: { type: "Error", cause: { type: "Error" } },
  });
});

test("an error anywhere in a line is its type and code, below the paths' depth too", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  // A stand-in for the AI SDK's APICallError, which carries the prompt and the answer.
  class ApiCallError extends Error {
    requestBodyValues = { messages: [{ content: "secret-prompt" }] };
    responseBody = "secret-body";
    toJSON() {
      return { requestBodyValues: this.requestBodyValues };
    }
  }
  const error = Object.assign(new ApiCallError("secret-message"), { code: "E_API" });
  const brief = { type: "ApiCallError", code: "E_API" };
  const cycle: Record<string, unknown> = { error };
  cycle.self = cycle;
  log.warn({ llm: { attempts: [{ attempt: 1, error }] } }, "attempts");
  log.warn({ a: { b: { c: { d: { e: error } } } } }, "five levels");
  log.warn({ a: { b: { c: { d: { e: { f: { g: { h: { i: { error } } } } } } } } } }, "too deep");
  log.warn({ cycle }, "cycle");
  const [attempts, five, deep, cyclic] = logs.lines();
  assert.doesNotMatch(logs.raw.join(), /secret-/);
  assert.deepEqual(attempts?.llm, { attempts: [{ attempt: 1, error: brief }] });
  assert.deepEqual(five?.a, { b: { c: { d: { e: brief } } } });
  assert.deepEqual(deep?.a, { b: { c: { d: { e: { f: { g: { h: { i: "[too deep]" } } } } } } } });
  assert.deepEqual(cyclic?.cycle, { error: brief, self: "[circular]" });
});

test("only an AppError writes its message; another error's reaches neither err nor msg", () => {
  const logs = collectLogs();
  const log = createLogger({ destination: logs.destination });
  // A stand-in for Prisma's validation error, whose message quotes the call's arguments.
  const quoting = Object.assign(
    new Error('create() invalid: { email: "jane.fixture@example.com" }'),
    {
      code: "P2009",
      details: "jane.fixture@example.com",
    },
  );
  const realm = vm.runInNewContext(
    'Object.assign(new Error("jane.fixture@example.com"), { x: 1 })',
  );
  const aggregate = new AggregateError(Array(12).fill(quoting), "jane.fixture@example.com");
  const getter = Object.defineProperty(new Error("jane.fixture@example.com"), "code", {
    get: () => {
      throw new Error("a getter that throws");
    },
  });
  log.error({ err: quoting });
  log.error(quoting);
  log.error({ err: realm });
  log.error({ err: aggregate }, "aggregate");
  log.error({ err: getter }, "getter");
  log.error({ err: new AppError("sender_failed") });
  // A message V8 writes into the stack as it is, with a line that looks like a frame.
  log.error({ err: new Error("parse failed:\n    at jane.fixture@example.com") }, "framed");
  const [under, first, other, many, thrown, app, framed] = logs.lines();
  assert.doesNotMatch(logs.raw.join(), /jane\.fixture/);
  assert.deepEqual([under?.msg, first?.msg, other?.msg], ["Error P2009", "Error P2009", "Error"]);
  const frames = (line: typeof under) => String((line?.err as { stack: unknown }).stack);
  assert.match(frames(under), /^ {4}at [^\n]*logging\.test\.ts/);
  assert.match(frames(framed), /^ {4}at [^\n]*logging\.test\.ts/);
  assert.deepEqual(
    { ...(under?.err as object), stack: 0 },
    { type: "Error", code: "P2009", stack: 0 },
  );
  assert.deepEqual({ ...(other?.err as object), stack: 0 }, { type: "Error", stack: 0 });
  const errors = (many?.err as { errors: unknown[] }).errors;
  assert.deepEqual(errors, Array(10).fill({ type: "Error", code: "P2009" }));
  assert.deepEqual(thrown?.err, { type: "Error" });
  assert.deepEqual(
    [app?.msg, (app?.err as { message: unknown }).message],
    ["sender_failed", "sender_failed"],
  );
});
