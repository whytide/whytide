// The quickemailverification adapter's mapping tests (../README.md "Tests"), offline: qevEmailVerifier()
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
import { qevEmailVerifier, quickEmailVerificationAdapter } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
/** A deliverable address's answer, as the documentation's example has it: booleans as text. */
const DELIVERABLE = {
  result: "valid",
  reason: "accepted_email",
  disposable: "false",
  accept_all: "false",
  role: "false",
  free: "false",
  email: "ada.valid@copper-harbor.example",
  user: "ada.valid",
  domain: "copper-harbor.example",
  mx_record: "mx.copper-harbor.example",
  mx_domain: "copper-harbor.example",
  safe_to_send: "true",
  did_you_mean: "",
  success: "true",
  message: null,
};
const answer = (fields: Record<string, unknown>): Answer => ({
  body: { ...DELIVERABLE, ...fields },
});
/** The vendor's answer for each verdict of the contract. */
const BY_VERDICT: Readonly<Record<EmailVerdict, Answer>> = {
  valid: answer({}),
  catch_all: answer({ accept_all: "true", safe_to_send: "false" }),
  risky: answer({ disposable: "true", safe_to_send: "false" }),
  invalid: answer({ result: "invalid", reason: "rejected_email", safe_to_send: "false" }),
  unknown: answer({ result: "unknown", reason: "timeout", safe_to_send: "false" }),
};
const FAILURES: Readonly<Record<EmailVerifierFailure, Answer>> = {
  verifier_rate_limited: {
    status: 429,
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
    body: { success: "false", message: "Too many requests" },
  },
  verifier_allowance_spent: { status: 402, body: { success: "false", message: "Low credits" } },
  verifier_unauthorized: { status: 401, body: { success: "false", message: "Invalid API key" } },
  verifier_provider_error: { status: PROVIDER_ERROR_STATUS },
};

const vendor = await startVendor(
  ({ query }) => BY_VERDICT[verdictOfAddress(query.email) ?? "valid"],
);
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  qevEmailVerifier({ origin, apiKey: KEY, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const name = quickEmailVerificationAdapter.name;
const local = { port: emailVerifierPort, name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailVerifierPort, implementation, { adapter: name });
const qev = bound();
const verify = () => qev.verifyEmail({ address: addressWith("valid") });

contractSuite(emailVerifierPort, local, emailVerifierCases(vendorWorld(vendor, FAILURES)));

describe("the quickemailverification adapter against a local vendor", () => {
  it("sends GET /v1/verify the address and the key, in the query, and nothing else; checked at the vendor's answer", async () => {
    const before = vendor.requests.length;
    const address = addressWith("valid");
    assert.deepEqual(await qev.verifyEmail({ address }), {
      verdict: "valid",
      checkedAt: new Date(NOW),
    });
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [["GET", "/v1/verify", { email: address, apikey: KEY }, ""]],
    );
    const headers = JSON.stringify(requests[0]?.headers).toLowerCase();
    for (const value of [KEY, address, "authorization", "cookie"]) {
      assert.ok(!headers.includes(value.toLowerCase()), `${value} in a header`);
    }
  });

  it("each row of the mapping table: an accept-all domain is catch_all, never valid; disposable, role and a full mailbox risky", async () => {
    await assertVerdicts(qev, vendor, [
      ["valid", answer({}), "valid"],
      ["valid, booleans as JSON", answer({ accept_all: false, disposable: false }), "valid"],
      ["valid, accept-all", answer({ accept_all: "true" }), "catch_all"],
      ["valid, accept-all as JSON", answer({ accept_all: true }), "catch_all"],
      [
        "accept-all and disposable",
        answer({ accept_all: "true", disposable: "true" }),
        "catch_all",
      ],
      [
        "unknown on an accept-all domain",
        answer({ result: "unknown", accept_all: "true" }),
        "catch_all",
      ],
      ["valid, disposable", answer({ disposable: "true" }), "risky"],
      ["valid, role", answer({ role: "true" }), "risky"],
      ["full mailbox", answer({ result: "invalid", reason: "exceeded_storage" }), "risky"],
      ["invalid", answer({ result: "invalid", reason: "rejected_email" }), "invalid"],
      ["invalid domain", answer({ result: "invalid", reason: "invalid_domain" }), "invalid"],
      [
        "invalid on an accept-all domain",
        answer({ result: "invalid", accept_all: "true" }),
        "invalid",
      ],
      ["unknown", answer({ result: "unknown", reason: "no_connect" }), "unknown"],
      ["a result it does not list", answer({ result: "maybe" }), "unknown"],
    ]);
  });

  it("the codes: 402 the credits gone; 401 and 403 unauthorized; 429 the rate limit, Retry-After's seconds or date, else 60 s; 500 with its status; not JSON, or success false, the provider error", async () => {
    const fails = async (served: Answer, code: string, details: Record<string, unknown>) => {
      vendor.answerNext(served);
      await assert.rejects(verify(), failsWith(code, details), JSON.stringify(served));
    };
    await fails({ status: 402 }, "verifier_allowance_spent", { status: 402 });
    await fails({ status: 401 }, "verifier_unauthorized", { status: 401 });
    await fails({ status: 403 }, "verifier_unauthorized", { status: 403 });
    await fails({ status: 429 }, "verifier_rate_limited", { retryAfterSec: 60 });
    const date = new Date(NOW + 90_000).toUTCString();
    await fails({ status: 429, headers: { "retry-after": date } }, "verifier_rate_limited", {
      retryAfterSec: 90,
    });
    await fails({ status: 500 }, "verifier_provider_error", { status: 500 });
    await fails({ body: "<html>" }, "verifier_provider_error", { status: 200, reason: "not_json" });
    const offShape = { reason: "off_shape" };
    await fails(answer({ success: "false" }), "verifier_provider_error", offShape);
    await fails({ body: { success: "true" } }, "verifier_provider_error", offShape);
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
    const echo = { success: "false", message: `bad key ${KEY} for ${address}` };
    const served: Answer[] = [
      { status: 429, body: echo },
      { status: 402, body: echo },
      { status: 401, body: echo },
      { status: 500, body: echo },
      { status: 302, headers: { location: `${vendor.origin}/?apikey=${KEY}&email=${address}` } },
      { body: `quillmarsh ${KEY}` },
      answer({ success: "false", message: echo.message }),
    ];
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...served.map((next) => () => {
        vendor.answerNext(next);
        return qev.verifyEmail({ address });
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
    assert.deepEqual(leaked([KEY, address, "quillmarsh", vendor.origin, "apikey"], seen), []);
  });

  it("as a host starts it: the free plan's 100 a day unless QUICKEMAILVERIFICATION_ALLOWANCE sets one; not open data; QUICKEMAILVERIFICATION_API_KEY required", async () => {
    const module = import.meta.resolve("../index.ts");
    const adapter = "quickEmailVerificationAdapter";
    const empty = { QUICKEMAILVERIFICATION_API_KEY: "", QUICKEMAILVERIFICATION_ALLOWANCE: "" };
    assert.deepEqual(await startedIn(module, adapter, empty), {
      openData: false,
      allowance: { calls: 100, per: "day" },
      created: "config_invalid",
    });
    const set = {
      QUICKEMAILVERIFICATION_API_KEY: KEY,
      QUICKEMAILVERIFICATION_ALLOWANCE: "5000/month",
    };
    assert.deepEqual(await startedIn(module, adapter, set), {
      openData: false,
      allowance: { calls: 5000, per: "month" },
      created: "created",
    });
  });
});
