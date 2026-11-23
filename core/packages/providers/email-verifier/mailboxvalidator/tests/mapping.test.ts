// The mailboxvalidator adapter's mapping tests (../README.md "Tests"), offline: mbvEmailVerifier()
// against a vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering
// synthetic answers shaped like the vendor's documentation, never recorded, and recording each
// request. No vendor is called; the key is made up for the run. First the port's contract suite in
// that world; then the request, each row of the README's mapping table, each answer's code, the
// pattern's redirect, bound and timeout, what a run leaves behind, and the adapter as a host starts it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import {
  type EmailVerifierFailure,
  emailVerifierCases,
  PROVIDER_ERROR_STATUS,
  RETRY_AFTER_SEC,
} from "../../contract.ts";
import { type EmailVerdict, emailVerifierPort } from "../../port.ts";
import {
  type Answer,
  addressWith,
  assertVerdicts,
  checkPattern,
  closedOrigin,
  failsWith,
  leaked,
  startedIn,
  startVendor,
  traces,
  vendorWorld,
  verdictOfAddress,
} from "../../tests/fixtures/vendor.ts";
import { MAX_ANSWER_BYTES, TIMEOUT_MS } from "../constants.ts";
import { mailboxValidatorAdapter, mbvEmailVerifier } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
/** A deliverable address's answer, every field of the documentation's table. */
const DELIVERABLE = {
  email_address: "ada.valid@copper-harbor.example",
  base_email_address: "ada.valid@copper-harbor.example",
  domain: "copper-harbor.example",
  is_free: false,
  is_syntax: true,
  is_domain: true,
  is_smtp: true,
  is_verified: true,
  is_server_down: false,
  is_greylisted: false,
  is_disposable: false,
  is_suppressed: false,
  is_role: false,
  is_high_risk: false,
  is_catchall: false,
  is_dmarc_enforced: false,
  is_strict_spf: false,
  website_exist: true,
  mailboxvalidator_score: 0.83,
  time_taken: 1.24,
  status: true,
  credits_available: 299,
};
const answer = (fields: Record<string, unknown>): Answer => ({
  body: { ...DELIVERABLE, ...fields },
});
const vendorError = (status: number, error_code: number, error_message: string): Answer => ({
  status,
  body: { error: { error_code, error_message } },
});
/** The vendor's answer for each verdict of the contract. */
const BY_VERDICT: Readonly<Record<EmailVerdict, Answer>> = {
  valid: answer({}),
  catch_all: answer({ is_catchall: true, mailboxvalidator_score: 0.5 }),
  risky: answer({ is_disposable: true, status: false }),
  invalid: answer({ is_verified: false, status: false }),
  unknown: answer({ is_verified: null, is_greylisted: true, status: false }),
};
const FAILURES: Readonly<Record<EmailVerifierFailure, Answer>> = {
  verifier_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  verifier_allowance_spent: vendorError(401, 10004, "Insufficient credits."),
  verifier_unauthorized: vendorError(401, 10001, "API key not found."),
  verifier_provider_error: { status: PROVIDER_ERROR_STATUS },
};

const vendor = await startVendor(
  ({ query }) => BY_VERDICT[verdictOfAddress(query.email) ?? "valid"],
);
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  mbvEmailVerifier({ origin, apiKey: KEY, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const name = mailboxValidatorAdapter.name;
const local = { port: emailVerifierPort, name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailVerifierPort, implementation, { adapter: name });
const mbv = bound();
const verify = () => mbv.verifyEmail({ address: addressWith("valid") });

contractSuite(emailVerifierPort, local, emailVerifierCases(vendorWorld(vendor, FAILURES)));

describe("the mailboxvalidator adapter against a local vendor", () => {
  it("sends GET /v2/validation/single the address and the key, in the query, and nothing else; checked at the vendor's answer", async () => {
    const before = vendor.requests.length;
    const address = addressWith("valid");
    assert.deepEqual(await mbv.verifyEmail({ address }), {
      verdict: "valid",
      checkedAt: new Date(NOW),
    });
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [["GET", "/v2/validation/single", { email: address, key: KEY }, ""]],
    );
    const headers = JSON.stringify(requests[0]?.headers).toLowerCase();
    for (const value of [KEY, address, "authorization", "cookie"]) {
      assert.ok(!headers.includes(value.toLowerCase()), `${value} in a header`);
    }
  });

  it("each row of the mapping table: a catch-all domain is catch_all, never valid; disposable, role, suppressed and high risk risky", async () => {
    await assertVerdicts(mbv, vendor, [
      ["valid", answer({}), "valid"],
      ["catch-all", answer({ is_catchall: true }), "catch_all"],
      ["catch-all and role", answer({ is_catchall: true, is_role: true }), "catch_all"],
      ["disposable", answer({ is_disposable: true, status: false }), "risky"],
      ["role", answer({ is_role: true }), "risky"],
      ["suppressed", answer({ is_suppressed: true, status: false }), "risky"],
      ["high risk", answer({ is_high_risk: true, status: false }), "risky"],
      ["no mailbox", answer({ is_verified: false, status: false }), "invalid"],
      ["no MX", answer({ is_domain: false, is_verified: null, status: false }), "invalid"],
      ["bad syntax", answer({ is_syntax: false, status: false }), "invalid"],
      ["no mailbox on a catch-all", answer({ is_verified: false, is_catchall: true }), "invalid"],
      ["greylisted", answer({ is_verified: null, is_greylisted: true, status: false }), "unknown"],
      [
        "server down",
        answer({ is_verified: null, is_server_down: true, status: false }),
        "unknown",
      ],
      ["status false, nothing else", answer({ status: false }), "unknown"],
      ["status true, not verified", answer({ is_verified: null }), "unknown"],
    ]);
  });

  it("the codes: the vendor's 10004 at any status the credits gone; 10001 to 10003, 401 and 403 unauthorized; 429 the rate limit; 500 and its 10005 the provider error; not JSON, or no status, too", async () => {
    const fails = async (served: Answer, code: string, details: Record<string, unknown>) => {
      vendor.answerNext(served);
      await assert.rejects(verify(), failsWith(code, details), JSON.stringify(served));
    };
    const spent = "verifier_allowance_spent";
    await fails(vendorError(401, 10004, "Insufficient credits."), spent, { status: 401 });
    await fails(vendorError(200, 10004, "Insufficient credits."), spent, { status: 200 });
    await fails({ status: 402 }, spent, { status: 402 });
    for (const code of [10001, 10002, 10003]) {
      await fails(vendorError(401, code, "API key."), "verifier_unauthorized", { status: 401 });
    }
    await fails({ status: 403 }, "verifier_unauthorized", { status: 403 });
    await fails({ status: 429 }, "verifier_rate_limited", { retryAfterSec: 60 });
    const provider = "verifier_provider_error";
    await fails(vendorError(500, 10005, "Unknown error."), provider, { status: 500 });
    await fails(vendorError(400, 10000, "Missing parameter."), provider, { status: 400 });
    await fails(vendorError(200, 10005, "Unknown error."), provider, { status: 200 });
    await fails({ body: "<html>" }, provider, { status: 200, reason: "not_json" });
    await fails(answer({ status: "True" }), provider, { reason: "off_shape" });
  });

  it("a redirect is never followed, an answer past 64 KiB never read whole, no answer within 30 s given up, a refused connection: verifier_provider_error", async (t) => {
    await checkPattern(t, vendor, verify, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: TIMEOUT_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, TIMEOUT_MS], [64 * 1024, 30_000]);
    const closed = bound(onVendor(await closedOrigin()));
    await assert.rejects(
      closed.verifyEmail({ address: addressWith("valid") }),
      failsWith("verifier_provider_error", { reason: "network", code: "ECONNREFUSED" }),
    );
  });

  it("no key, no address and no URL in an error, a log line, the console or a metric label", async (t) => {
    const address = "quillmarsh.ada@quillmarsh-tide.example";
    const echo = (status: number, code: number): Answer => ({
      status,
      body: { error: { error_code: code, error_message: `${KEY} ${address}` } },
    });
    const served: Answer[] = [
      { status: 429, body: { message: `${KEY} ${address}` } },
      echo(401, 10004),
      echo(401, 10001),
      echo(500, 10005),
      echo(200, 10005),
      { status: 302, headers: { location: `${vendor.origin}/?key=${KEY}&email=${address}` } },
      { body: `quillmarsh ${KEY}` },
    ];
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...served.map((next) => () => {
        vendor.answerNext(next);
        return mbv.verifyEmail({ address });
      }),
      () => {
        vendor.answerNext({ silent: true });
        return slow.verifyEmail({ address });
      },
      () => closed.verifyEmail({ address }),
    ];
    const { errors, seen, logged, counted } = await traces(t, calls);
    assert.equal(errors.length, calls.length, "every call failed");
    assert.equal(logged, calls.length, "every failure was logged");
    assert.ok(counted > 0, "the calls were counted");
    assert.deepEqual(leaked([KEY, address, "quillmarsh", vendor.origin, "key="], seen), []);
  });

  it("as a host starts it: the free plan's 300 a month unless MAILBOXVALIDATOR_ALLOWANCE sets one; not open data; MAILBOXVALIDATOR_API_KEY required", async () => {
    const module = import.meta.resolve("../index.ts");
    const adapter = "mailboxValidatorAdapter";
    const empty = { MAILBOXVALIDATOR_API_KEY: "", MAILBOXVALIDATOR_ALLOWANCE: "" };
    assert.deepEqual(await startedIn(module, adapter, empty), {
      openData: false,
      allowance: { calls: 300, per: "month" },
      created: "config_invalid",
    });
    const set = { MAILBOXVALIDATOR_API_KEY: KEY, MAILBOXVALIDATOR_ALLOWANCE: "1000/month" };
    assert.deepEqual(await startedIn(module, adapter, set), {
      openData: false,
      allowance: { calls: 1000, per: "month" },
      created: "created",
    });
  });
});
