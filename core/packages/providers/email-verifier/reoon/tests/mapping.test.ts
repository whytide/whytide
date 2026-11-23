// The reoon adapter's mapping tests (../README.md "Tests"), offline: reoonEmailVerifier() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering synthetic answers
// shaped like the vendor's documentation, never recorded, and recording each request. No vendor is
// called; the key is made up for the run. First the port's contract suite in that world; then the
// request, each row of the README's mapping table, each answer's code, the pattern's redirect, bound
// and timeout, what a run leaves behind, and the adapter as a host starts it.
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
import { reoonAdapter, reoonEmailVerifier } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
/** A deliverable address's answer in power mode, as the documentation's example has it. */
const SAFE_ANSWER = {
  email: "ada.valid@copper-harbor.example",
  status: "safe",
  overall_score: 98,
  username: "ada.valid",
  domain: "copper-harbor.example",
  is_safe_to_send: true,
  is_valid_syntax: true,
  is_disposable: false,
  is_role_account: false,
  can_connect_smtp: true,
  has_inbox_full: false,
  is_catch_all: false,
  is_deliverable: true,
  is_disabled: false,
  is_spamtrap: false,
  is_free_email: false,
  mx_accepts_mail: true,
  mx_records: ["mx.copper-harbor.example"],
  verification_mode: "power",
};
const answer = (fields: Record<string, unknown>): Answer => ({
  body: { ...SAFE_ANSWER, ...fields },
});
const refused = (reason: string, status = 200): Answer => ({
  status,
  body: { status: "error", reason },
});
/** The vendor's answer for each verdict of the contract. */
const BY_VERDICT: Readonly<Record<EmailVerdict, Answer>> = {
  valid: answer({}),
  catch_all: answer({ status: "catch_all", is_catch_all: true, is_safe_to_send: false }),
  risky: answer({ status: "role_account", is_role_account: true }),
  invalid: answer({ status: "invalid", is_deliverable: false }),
  unknown: answer({ status: "unknown", can_connect_smtp: false }),
};
const FAILURES: Readonly<Record<EmailVerifierFailure, Answer>> = {
  verifier_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  verifier_allowance_spent: refused("Not enough credits."),
  verifier_unauthorized: refused("Invalid API key.", 401),
  verifier_provider_error: { status: PROVIDER_ERROR_STATUS },
};

const vendor = await startVendor(
  ({ query }) => BY_VERDICT[verdictOfAddress(query.email) ?? "valid"],
);
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  reoonEmailVerifier({ origin, apiKey: KEY, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const name = reoonAdapter.name;
const local = { port: emailVerifierPort, name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailVerifierPort, implementation, { adapter: name });
const reoon = bound();
const verify = () => reoon.verifyEmail({ address: addressWith("valid") });

contractSuite(emailVerifierPort, local, emailVerifierCases(vendorWorld(vendor, FAILURES)));

describe("the reoon adapter against a local vendor", () => {
  it("sends GET /api/v1/verify the address, the key and power mode, in the query, and nothing else; checked at the vendor's answer", async () => {
    const before = vendor.requests.length;
    const address = addressWith("valid");
    assert.deepEqual(await reoon.verifyEmail({ address }), {
      verdict: "valid",
      checkedAt: new Date(NOW),
    });
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [["GET", "/api/v1/verify", { email: address, key: KEY, mode: "power" }, ""]],
    );
    const headers = JSON.stringify(requests[0]?.headers).toLowerCase();
    for (const value of [KEY, address, "authorization", "cookie"]) {
      assert.ok(!headers.includes(value.toLowerCase()), `${value} in a header`);
    }
  });

  it("each row of the mapping table: catch_all, or the catch-all flag, is catch_all, never valid; disposable, a full inbox, a role and a spam trap risky", async () => {
    await assertVerdicts(reoon, vendor, [
      ["safe", answer({}), "valid"],
      ["catch_all", answer({ status: "catch_all" }), "catch_all"],
      ["safe, but the catch-all flag", answer({ is_catch_all: true }), "catch_all"],
      [
        "role on a catch-all domain",
        answer({ status: "role_account", is_catch_all: true }),
        "catch_all",
      ],
      ["disposable", answer({ status: "disposable" }), "risky"],
      ["inbox_full", answer({ status: "inbox_full" }), "risky"],
      ["role_account", answer({ status: "role_account" }), "risky"],
      ["spamtrap", answer({ status: "spamtrap", is_spamtrap: "None" }), "risky"],
      ["invalid", answer({ status: "invalid" }), "invalid"],
      ["disabled", answer({ status: "disabled" }), "invalid"],
      [
        "invalid on a catch-all domain",
        answer({ status: "invalid", is_catch_all: true }),
        "invalid",
      ],
      ["unknown", answer({ status: "unknown" }), "unknown"],
      ["quick mode's valid", answer({ status: "valid", verification_mode: "quick" }), "unknown"],
    ]);
  });

  it("the codes: its error answer, at any status, naming the credits or the balance the allowance spent, the key unauthorized; 402 spent; 401 and 403 unauthorized; 429 the rate limit; any other error the provider error", async () => {
    const fails = async (served: Answer, code: string, details: Record<string, unknown>) => {
      vendor.answerNext(served);
      await assert.rejects(verify(), failsWith(code, details), JSON.stringify(served));
    };
    const spent = "verifier_allowance_spent";
    await fails(refused("Not enough credits."), spent, { status: 200 });
    await fails(refused("Insufficient balance", 400), spent, { status: 400 });
    await fails({ status: 402 }, spent, { status: 402 });
    await fails(refused("API key is not active."), "verifier_unauthorized", { status: 200 });
    await fails({ status: 403 }, "verifier_unauthorized", { status: 403 });
    await fails({ status: 429 }, "verifier_rate_limited", { retryAfterSec: 60 });
    const provider = "verifier_provider_error";
    await fails(refused("Something went wrong"), provider, { status: 200 });
    await fails(refused("Something went wrong", 500), provider, { status: 500 });
    await fails({ body: "<html>" }, provider, { status: 200, reason: "not_json" });
    await fails(answer({ status: true }), provider, { reason: "off_shape" });
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
    const echo = `credits for ${KEY} ${address}`;
    const served: Answer[] = [
      { status: 429, body: { status: "error", reason: echo } },
      refused(echo),
      refused(`key ${KEY} ${address}`, 401),
      refused(`${KEY} ${address}`, 500),
      { status: 302, headers: { location: `${vendor.origin}/?key=${KEY}&email=${address}` } },
      { body: `quillmarsh ${KEY}` },
      answer({ status: 7, email: address }),
    ];
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...served.map((next) => () => {
        vendor.answerNext(next);
        return reoon.verifyEmail({ address });
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

  it("as a host starts it: the free plan's 20 a day unless REOON_ALLOWANCE sets one; not open data; REOON_API_KEY required", async () => {
    const module = import.meta.resolve("../index.ts");
    const empty = { REOON_API_KEY: "", REOON_ALLOWANCE: "" };
    assert.deepEqual(await startedIn(module, "reoonAdapter", empty), {
      openData: false,
      allowance: { calls: 20, per: "day" },
      created: "config_invalid",
    });
    const set = { REOON_API_KEY: KEY, REOON_ALLOWANCE: "500/day" };
    assert.deepEqual(await startedIn(module, "reoonAdapter", set), {
      openData: false,
      allowance: { calls: 500, per: "day" },
      created: "created",
    });
  });
});
