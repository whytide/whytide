// The zerobounce adapter's mapping tests (../README.md "Tests"), offline: zeroBounceEmailVerifier()
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
import { zeroBounceAdapter, zeroBounceEmailVerifier } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
/** A deliverable address's answer, as the documentation's example has it. */
const DELIVERABLE = {
  address: "ada.valid@copper-harbor.example",
  status: "valid",
  sub_status: "",
  free_email: false,
  catchall_domain: false,
  did_you_mean: null,
  account: "ada.valid",
  domain: "copper-harbor.example",
  domain_age_days: "3431",
  smtp_provider: null,
  mx_found: "true",
  mx_record: "mx.copper-harbor.example",
  firstname: "Ada",
  lastname: "Example",
  gender: null,
  country: null,
  region: null,
  city: null,
  zipcode: null,
  processed_at: "2026-11-13 00:00:00.000",
};
const answer = (fields: Record<string, unknown>): Answer => ({
  body: { ...DELIVERABLE, ...fields },
});
const SAID = "Invalid API Key or your account ran out of credits";
/** The vendor's answer for each verdict of the contract. */
const BY_VERDICT: Readonly<Record<EmailVerdict, Answer>> = {
  valid: answer({}),
  catch_all: answer({ status: "catch-all", catchall_domain: true }),
  risky: answer({ status: "do_not_mail", sub_status: "disposable" }),
  invalid: answer({ status: "invalid", sub_status: "mailbox_not_found" }),
  unknown: answer({ status: "unknown", sub_status: "greylisted" }),
};
const FAILURES: Readonly<Record<EmailVerifierFailure, Answer>> = {
  verifier_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  verifier_allowance_spent: { body: { error: SAID } },
  verifier_unauthorized: { status: 401 },
  verifier_provider_error: { status: PROVIDER_ERROR_STATUS },
};

const vendor = await startVendor(
  ({ query }) => BY_VERDICT[verdictOfAddress(query.email) ?? "valid"],
);
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  zeroBounceEmailVerifier({
    origin,
    apiKey: KEY,
    now: () => NOW,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const name = zeroBounceAdapter.name;
const local = { port: emailVerifierPort, name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailVerifierPort, implementation, { adapter: name });
const zeroBounce = bound();
const verify = () => zeroBounce.verifyEmail({ address: addressWith("valid") });

contractSuite(emailVerifierPort, local, emailVerifierCases(vendorWorld(vendor, FAILURES)));

describe("the zerobounce adapter against a local vendor", () => {
  it("sends GET /v2/validate the address and the key, in the query, and nothing else, no ip_address; checked at the vendor's answer", async () => {
    const before = vendor.requests.length;
    const address = addressWith("valid");
    assert.deepEqual(await zeroBounce.verifyEmail({ address }), {
      verdict: "valid",
      checkedAt: new Date(NOW),
    });
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [["GET", "/v2/validate", { email: address, api_key: KEY }, ""]],
    );
    const headers = JSON.stringify(requests[0]?.headers).toLowerCase();
    for (const value of [KEY, address, "authorization", "cookie"]) {
      assert.ok(!headers.includes(value.toLowerCase()), `${value} in a header`);
    }
  });

  it("each row of the mapping table: catch-all, a vetted accept_all and a catch-all domain are catch_all, never valid; spam traps, abuse, do-not-mail and a full mailbox risky", async () => {
    const rows: [string, Answer, EmailVerdict][] = [
      ["valid", answer({}), "valid"],
      ["valid, alias", answer({ sub_status: "alias_address" }), "valid"],
      ["valid, accept_all", answer({ sub_status: "accept_all" }), "catch_all"],
      ["valid, role on accept_all", answer({ sub_status: "role_based_accept_all" }), "catch_all"],
      ["valid on a catch-all domain", answer({ catchall_domain: true }), "catch_all"],
      ["catch-all", answer({ status: "catch-all" }), "catch_all"],
      [
        "unknown on a catch-all domain",
        answer({ status: "unknown", catchall_domain: true }),
        "catch_all",
      ],
      [
        "full mailbox",
        answer({ status: "invalid", sub_status: "mailbox_quota_exceeded" }),
        "risky",
      ],
      ["spamtrap", answer({ status: "spamtrap" }), "risky"],
      ["abuse", answer({ status: "abuse" }), "risky"],
      ["role", answer({ status: "do_not_mail", sub_status: "role_based" }), "risky"],
      ["disposable", answer({ status: "do_not_mail", sub_status: "disposable" }), "risky"],
      ["toxic", answer({ status: "do_not_mail", sub_status: "toxic" }), "risky"],
      ["possible trap", answer({ status: "do_not_mail", sub_status: "possible_trap" }), "risky"],
      ["no mailbox", answer({ status: "invalid", sub_status: "mailbox_not_found" }), "invalid"],
      ["no DNS", answer({ status: "invalid", sub_status: "no_dns_entries" }), "invalid"],
      [
        "invalid on a catch-all domain",
        answer({ status: "invalid", catchall_domain: true }),
        "invalid",
      ],
      ["unknown", answer({ status: "unknown", sub_status: "timeout_exceeded" }), "unknown"],
      ["a status it does not list", answer({ status: "maybe" }), "unknown"],
    ];
    await assertVerdicts(zeroBounce, vendor, rows);
  });

  it("the codes: its error answer, at any status, naming the credits the allowance spent, the key alone unauthorized; 401 and 403 unauthorized; 429 the rate limit; 500 and other errors the provider error; not JSON, or no status, too", async () => {
    const fails = async (served: Answer, code: string, details: Record<string, unknown>) => {
      vendor.answerNext(served);
      await assert.rejects(verify(), failsWith(code, details), JSON.stringify(served));
    };
    const spent = "verifier_allowance_spent";
    await fails({ body: { error: SAID } }, spent, { status: 200 });
    await fails({ status: 400, body: { error: SAID } }, spent, { status: 400 });
    await fails({ body: { error: "Invalid API key" } }, "verifier_unauthorized", { status: 200 });
    await fails({ status: 403 }, "verifier_unauthorized", { status: 403 });
    await fails({ status: 429 }, "verifier_rate_limited", { retryAfterSec: 60 });
    const provider = "verifier_provider_error";
    await fails({ status: 500, body: { error: "Server busy" } }, provider, { status: 500 });
    await fails({ body: { error: "Missing parameter" } }, provider, { status: 200 });
    await fails({ body: "<html>" }, provider, { status: 200, reason: "not_json" });
    await fails(answer({ status: null }), provider, { reason: "off_shape" });
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

  it("no key, no address, no URL and no name the vendor gives back in an error, a log line, the console or a metric label", async (t) => {
    const address = "quillmarsh.ada@quillmarsh-tide.example";
    const echo = { error: `${SAID}: ${KEY} ${address}` };
    const served: Answer[] = [
      { status: 429, body: echo },
      { body: echo },
      { status: 401, body: echo },
      { status: 500, body: echo },
      { status: 302, headers: { location: `${vendor.origin}/?api_key=${KEY}&email=${address}` } },
      { body: `quillmarsh ${KEY}` },
      answer({ status: 7, address, firstname: "Quillmarsh" }),
    ];
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...served.map((next) => () => {
        vendor.answerNext(next);
        return zeroBounce.verifyEmail({ address });
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
    assert.deepEqual(leaked([KEY, address, "quillmarsh", vendor.origin, "api_key"], seen), []);
  });

  it("as a host starts it: the free plan's 100 a month unless ZEROBOUNCE_ALLOWANCE sets one; not open data; ZEROBOUNCE_API_KEY required", async () => {
    const module = import.meta.resolve("../index.ts");
    const empty = { ZEROBOUNCE_API_KEY: "", ZEROBOUNCE_ALLOWANCE: "" };
    assert.deepEqual(await startedIn(module, "zeroBounceAdapter", empty), {
      openData: false,
      allowance: { calls: 100, per: "month" },
      created: "config_invalid",
    });
    const set = { ZEROBOUNCE_API_KEY: KEY, ZEROBOUNCE_ALLOWANCE: "2000/month" };
    assert.deepEqual(await startedIn(module, "zeroBounceAdapter", set), {
      openData: false,
      allowance: { calls: 2000, per: "month" },
      created: "created",
    });
  });
});
