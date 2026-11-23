// The snov adapter's mapping tests (../README.md "Tests"), offline: snovEmailFinder() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the token call,
// the task's start and its result with the synthetic fixture of fixtures/ (shaped like Snov.io's
// documentation, never recorded), and recording each request. No vendor is called; the client's id
// and secret are made up for the run. First the port's contract suite in that world; then the
// requests, the token's reuse and its one fetch again on a 401, the result not ready within the
// budget, each row of the README's mapping table, the pattern, and what a run leaves behind.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import {
  type EmailFinderFailure,
  emailFinderCases,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
} from "../../contract.ts";
import { emailFinderPort, type FindEmailInput } from "../../port.ts";
import {
  type Answer,
  allowanceAtStart,
  checkPattern,
  closedOrigin,
  failsWith,
  leaked,
  type Received,
  startVendor,
  traces,
  vendorWorld,
} from "../../tests/fixtures/vendor.ts";
import { BUDGET_MS, MAX_ANSWER_BYTES } from "../constants.ts";
import { snovAdapter, snovEmailFinder } from "../index.ts";

const ID = `id${randomBytes(16).toString("hex")}`;
const SECRET = `secret${randomBytes(16).toString("hex")}`;
const TOKEN = `token${randomBytes(16).toString("hex")}`;
const DOMAIN = "copper-harbor.example";
const ADA = { firstName: "Ada", lastName: "Example", companyDomain: DOMAIN };
const GRACE = { firstName: "Grace", lastName: "Sample", companyDomain: DOMAIN };
const RESULT = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "result.json"), "utf8"),
);
const [ROW] = RESULT.data;
/** result.json with its addresses replaced. */
const result = (emails: readonly Record<string, unknown>[], status = "completed"): Answer => ({
  body: { ...RESULT, status, data: [{ ...ROW, result: emails }] },
});
const email = (changes: Record<string, unknown> = {}) => ({ ...ROW.result[0], ...changes });
const TOKEN_ANSWER: Answer = {
  body: { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 },
};
const started = (task: string): Answer => ({ body: { data: { task_hash: task }, meta: {} } });
const error = (status: number, message: string) => ({ status, body: { success: false, message } });

const vendor = await startVendor(({ path, query, body }) => {
  if (path === "/v1/oauth/access_token") return TOKEN_ANSWER;
  if (path.endsWith("/start")) {
    const [row] = (JSON.parse(body) as { rows: { first_name: string }[] }).rows;
    return started(`task-${row?.first_name}`);
  }
  if (query.task_hash === "task-Ada") return { body: RESULT };
  if (query.task_hash === "task-Grace") {
    return result([email({ email: `grace@${DOMAIN}`, smtp_status: null })]);
  }
  return result([]);
});
after(() => vendor.close());

const NOW = Date.parse("2026-11-13T00:00:00Z");
const onVendor = (origin = vendor.origin, now = () => NOW) =>
  snovEmailFinder({ origin, clientId: ID, clientSecret: SECRET, pollMs: 5, now });
const local = { port: emailFinderPort, name: snovAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailFinderPort, implementation, { adapter: snovAdapter.name });
const snov = bound();
await snov.findEmail(ADA); // the token, held by the instance the tests below queue answers for

/** Snov.io's answer for each of the contract's codes, the token already held: the credits gone come in the result. */
const FAILURES: Readonly<Record<EmailFinderFailure, Answer | readonly Answer[]>> = {
  finder_rate_limited: {
    ...error(429, "Too many requests"),
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
  },
  finder_allowance_spent: [started("task-Grace"), result([], "not_enough_credits")],
  finder_unauthorized: error(403, "Forbidden"),
  finder_provider_error: error(PROVIDER_ERROR_STATUS, "Unavailable"),
};
contractSuite(
  emailFinderPort,
  local,
  emailFinderCases(
    vendorWorld(
      vendor,
      {
        person: { person: GRACE, address: `grace@${DOMAIN}` },
        checked: { person: ADA, address: `ada@${DOMAIN}`, vendorVerdict: "valid" },
      },
      { firstName: "Nobody", lastName: "Known", companyDomain: DOMAIN },
      FAILURES,
    ),
  ),
);

async function answering(next: Answer, input: FindEmailInput = ADA) {
  vendor.answerNext(started("task-x"));
  vendor.answerNext(next);
  return snov.findEmail(input);
}
const found = (vendorVerdict?: string) => ({
  result: "found",
  address: `ada@${DOMAIN}`,
  ...(vendorVerdict ? { vendorVerdict } : {}),
});
const paths = (requests: readonly Received[]) =>
  requests.map(({ method, path }) => `${method} ${path}`);

describe("the snov adapter against a local vendor", () => {
  it("fetches a token with the id and secret in the form body only, starts the task with the one person and reads its result with the bearer token; nothing else is sent", async () => {
    const fresh = bound();
    const before = vendor.requests.length;
    assert.deepEqual(await fresh.findEmail(ADA), found("valid"));
    const [token, start, read] = vendor.requests.slice(before);
    assert.deepEqual(paths([token, start, read] as Received[]), [
      "POST /v1/oauth/access_token",
      "POST /v2/emails-by-domain-by-name/start",
      "GET /v2/emails-by-domain-by-name/result",
    ]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(token?.body)), {
      grant_type: "client_credentials",
      client_id: ID,
      client_secret: SECRET,
    });
    assert.equal(token?.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(start?.body ?? ""), {
      rows: [{ first_name: "Ada", last_name: "Example", domain: DOMAIN }],
    });
    assert.deepEqual(read?.query, { task_hash: "task-Ada" });
    for (const request of [start, read]) {
      assert.equal(request?.headers.authorization, `Bearer ${TOKEN}`);
      const seen = JSON.stringify([request?.url, request?.body]);
      assert.ok(!seen.includes(ID) && !seen.includes(SECRET) && !seen.includes(TOKEN));
    }
    assert.ok(!token?.url.includes(SECRET) && !token?.url.includes(ID), "never in the URL");
  });

  it("the token is fetched once and reused until it expires; a 401 fetches it again, once, and a second 401 is unauthorized", async () => {
    let clock = NOW;
    const fresh = bound(onVendor(vendor.origin, () => clock));
    const tokens = () => vendor.requests.filter((r) => r.path === "/v1/oauth/access_token").length;
    const before = tokens();
    await fresh.findEmail(ADA);
    await fresh.findEmail(GRACE);
    assert.equal(tokens() - before, 1, "reused");
    clock += (3600 - 60) * 1000;
    await fresh.findEmail(ADA);
    assert.equal(tokens() - before, 2, "fetched again before it expires");
    vendor.answerNext(error(401, "Expired token"));
    assert.deepEqual(await fresh.findEmail(ADA), found("valid"));
    assert.equal(tokens() - before, 3, "a 401 fetched it again, once");
    const start = vendor.requests.length;
    vendor.answerNext(error(401, "Expired token"));
    vendor.answerNext(TOKEN_ANSWER);
    vendor.answerNext(error(401, "Expired token"));
    await assert.rejects(fresh.findEmail(ADA), failsWith("finder_unauthorized", { status: 401 }));
    assert.deepEqual(paths(vendor.requests.slice(start)), [
      "POST /v2/emails-by-domain-by-name/start",
      "POST /v1/oauth/access_token",
      "POST /v2/emails-by-domain-by-name/start",
    ]);
  });

  it("a refused id or secret at the token call is unauthorized, a 400 invalid_client included, without a second token call", async () => {
    for (const answer of [
      { status: 400, body: { error: "invalid_client", error_description: "Bad client" } },
      { status: 401, body: { error: "invalid_client" } },
    ]) {
      const before = vendor.requests.length;
      vendor.answerNext(answer);
      const refused = failsWith("finder_unauthorized", { status: answer.status });
      await assert.rejects(bound().findEmail(ADA), refused);
      assert.equal(vendor.requests.length - before, 1);
    }
    const offShape = failsWith("finder_provider_error", { reason: "off_shape" });
    vendor.answerNext({ body: { access_token: "", expires_in: 3600 } });
    await assert.rejects(bound().findEmail(ADA), offShape);
  });

  it("a result still in progress at the end of the budget is the provider error, not_ready; one ready after a few reads is found", async () => {
    vendor.answerNext(started("task-x"));
    for (let read = 0; read < 3; read += 1) vendor.answerNext(result([], "in_progress"));
    vendor.answerNext({ body: RESULT });
    assert.deepEqual(await snov.findEmail(ADA), found("valid"));
    const stuck = await startVendor(({ path }) =>
      path.endsWith("/start") ? started("task-x") : result([], "in_progress"),
    );
    try {
      const pending = bound(
        snovEmailFinder({
          origin: stuck.origin,
          clientId: ID,
          clientSecret: SECRET,
          budgetMs: 200,
        }),
      );
      stuck.answerNext(TOKEN_ANSWER);
      const notReady = failsWith("finder_provider_error", { reason: "not_ready" });
      await assert.rejects(pending.findEmail(ADA), notReady);
    } finally {
      await stuck.close();
    }
  });

  it("the first valid address, else the first; webmail or disposable risky; unknown with catchall catch_all, never valid; other unknowns unknown; a status it does not document no verdict; a format Snov.io calls invalid skipped", async () => {
    const rows = [
      [[email({ smtp_status: "unknown" }), email({ email: `ada@${DOMAIN}` })], "valid"],
      [[email({ smtp_status: "unknown", unknown_status_reason: "catchall" })], "catch_all"],
      [[email({ smtp_status: "unknown", unknown_status_reason: "greylist" })], "unknown"],
      [[email({ is_webmail: true })], "risky"],
      [[email({ is_disposable: true, smtp_status: "unknown" })], "risky"],
      [[email({ smtp_status: "maybe" })], undefined],
      [[email({ email: "x@y.example", is_valid_format: false }), email()], "valid"],
    ] as const;
    for (const [emails, verdict] of rows) {
      assert.deepEqual(await answering(result(emails)), found(verdict), JSON.stringify(emails));
    }
  });

  it("nobody is not_found: no address, no row; an address in capitals lower-cased; one off the port's form, or an answer off Snov.io's shape, the provider error", async () => {
    assert.deepEqual(await answering(result([])), { result: "not_found" });
    assert.deepEqual(await answering({ body: { status: "completed", data: [] } }), {
      result: "not_found",
    });
    assert.deepEqual(await answering(result([email({ email: `ADA@${DOMAIN}` })])), found("valid"));
    const offShape = failsWith("finder_provider_error", { reason: "off_shape" });
    await assert.rejects(answering(result([email({ email: "ada at copper" })])), offShape);
    await assert.rejects(answering({ body: { status: "lost" } }), offShape);
    vendor.answerNext({ body: { data: {} } });
    await assert.rejects(snov.findEmail(ADA), offShape, "a start without its task");
  });

  it("the credits gone, in the result or as a 402, are finder_allowance_spent; a 429 the rate limit, else 60 s; a 403 unauthorized; a 500 the provider error", async () => {
    const inResult = failsWith("finder_allowance_spent", { status: 200 });
    await assert.rejects(answering(result([], "not_enough_credits")), inResult);
    vendor.answerNext(error(402, "No credits"));
    await assert.rejects(snov.findEmail(ADA), failsWith("finder_allowance_spent", { status: 402 }));
    vendor.answerNext(error(429, "Too many"));
    await assert.rejects(
      snov.findEmail(ADA),
      failsWith("finder_rate_limited", { retryAfterSec: 60 }),
    );
    await assert.rejects(
      answering(error(403, "No")),
      failsWith("finder_unauthorized", { status: 403 }),
    );
    await assert.rejects(
      answering(error(500, "Oops")),
      failsWith("finder_provider_error", { status: 500 }),
    );
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, nothing within the 10-second budget given up, a refused connection: finder_provider_error", async (t) => {
    await checkPattern(t, vendor, () => snov.findEmail(ADA), {
      maxBytes: MAX_ANSWER_BYTES,
      timeoutMs: BUDGET_MS,
    });
    const closed = bound(onVendor(await closedOrigin()));
    const network = failsWith("finder_provider_error", { reason: "network", code: "ECONNREFUSED" });
    await assert.rejects(closed.findEmail(ADA), network);
  });

  it("no id, secret, token, name, domain or address in an error, a log line, the console or a metric label", async (t) => {
    const person = {
      firstName: "Quillmarsh",
      lastName: "Tidewater",
      companyDomain: "tide.example",
    };
    const echo = (status: number) =>
      error(status, `${ID} ${SECRET} ${TOKEN} quillmarsh@tide.example`);
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...[echo(429), echo(402), echo(403), echo(500)].map((next) => () => answering(next, person)),
      () => answering(result([email({ email: `quillmarsh tidewater ${TOKEN}` })]), person),
      () => {
        vendor.answerNext({ status: 400, body: { error: "invalid_client", secret: SECRET } });
        return bound().findEmail(person);
      },
      () => answering({ status: 302, headers: { location: `/?token=${TOKEN}` } }, person),
      () => closed.findEmail(person),
    ];
    const { errors, seen, logged, counted } = await traces(t, calls);
    assert.equal(errors.length, calls.length, "every call failed");
    assert.equal(logged, calls.length, "every failure was logged");
    assert.ok(counted > 0, "the calls were counted");
    const values = [ID, SECRET, TOKEN, "quillmarsh", "tidewater", "tide.example"];
    assert.deepEqual(leaked(values, seen), []);
  });

  it("from the registry: the free plan's allowance, 50 a month, unless SNOV_ALLOWANCE sets one; SNOV_CLIENT_ID and SNOV_CLIENT_SECRET required at start", async () => {
    const startWith = (env: Record<string, string>) =>
      allowanceAtStart("snov", "SNOV_ALLOWANCE", env);
    const both = { SNOV_CLIENT_ID: ID, SNOV_CLIENT_SECRET: SECRET };
    const runs: Record<string, string>[] = [
      both,
      { ...both, SNOV_ALLOWANCE: "1000/month" },
      { ...both, SNOV_ALLOWANCE: "lots" },
      { SNOV_CLIENT_ID: ID, SNOV_CLIENT_SECRET: "" },
      { SNOV_CLIENT_ID: "", SNOV_CLIENT_SECRET: SECRET },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '{"calls":50,"per":"month"}',
      '{"calls":1000,"per":"month"}',
      "config_invalid",
      "config_invalid",
      "config_invalid",
    ]);
  });
});
