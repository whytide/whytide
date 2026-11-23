// The verifalia adapter's mapping tests (../README.md "Tests"), offline: verifaliaEmailVerifier()
// against a vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering
// synthetic jobs shaped like the vendor's documentation, never recorded, and recording each request.
// No vendor is called; the user is made up for the run. First the port's contract suite in that
// world; then the requests, a job read again until done and one never done in time, each row of the
// README's mapping table, each answer's code, the pattern's redirect, bound and timeout, what a run
// leaves behind, and the adapter as a host starts it.
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
import { BUDGET_MS, MAX_ANSWER_BYTES, POLLS_MAX } from "../constants.ts";
import { verifaliaAdapter, verifaliaEmailVerifier } from "../index.ts";

const USERNAME = `whytide-${randomBytes(4).toString("hex")}`;
const PASSWORD = `pw${randomBytes(16).toString("hex")}`;
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
const JOB = "4f6c0d8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f";
/** A finished job of one entry, `status` and `classification` its verdict's. */
const finished = (classification: unknown, status: unknown, overview = "Completed"): Answer => ({
  body: {
    overview: { id: JOB, status: overview, noOfEntries: 1, quality: "Standard" },
    entries: {
      meta: { isTruncated: false },
      data: [{ index: 0, inputData: addressWith("valid"), classification, status }],
    },
  },
});
const running: Answer = { status: 202, body: { overview: { id: JOB, status: "InProgress" } } };
/** The vendor's answer for each verdict of the contract. */
const BY_VERDICT: Readonly<Record<EmailVerdict, Answer>> = {
  valid: finished("Deliverable", "Success"),
  catch_all: finished("Risky", "ServerIsCatchAll"),
  risky: finished("Risky", "MailboxIsDea"),
  invalid: finished("Undeliverable", "MailboxDoesNotExist"),
  unknown: finished("Unknown", "SmtpConnectionTimeout"),
};
const FAILURES: Readonly<Record<EmailVerifierFailure, Answer>> = {
  verifier_rate_limited: { status: 429, headers: { "retry-after": String(RETRY_AFTER_SEC) } },
  verifier_allowance_spent: { status: 402, body: { title: "Payment Required", status: 402 } },
  verifier_unauthorized: { status: 401 },
  verifier_provider_error: { status: PROVIDER_ERROR_STATUS },
};

const vendor = await startVendor(({ body }) => {
  const address = body ? JSON.parse(body)?.entries?.[0]?.inputData : undefined;
  return BY_VERDICT[verdictOfAddress(address) ?? "valid"];
});
after(() => vendor.close());

const onVendor = (origin = vendor.origin, now = () => NOW) =>
  verifaliaEmailVerifier({ origin, username: USERNAME, password: PASSWORD, now });
const name = verifaliaAdapter.name;
const local = { port: emailVerifierPort, name, requires: [], create: () => onVendor() };
const bound = (implementation = onVendor()) =>
  bindPort(emailVerifierPort, implementation, { adapter: name });
const verifalia = bound();
const verify = (verifier = verifalia) => verifier.verifyEmail({ address: addressWith("valid") });
const requestsOf = (before: number) =>
  vendor.requests
    .slice(before)
    .map(({ method, path, query, body, headers }) => [
      method,
      path,
      query,
      body,
      headers.authorization,
    ]);

contractSuite(emailVerifierPort, local, emailVerifierCases(vendorWorld(vendor, FAILURES)));

describe("the verifalia adapter against a local vendor", () => {
  it("creates a job of one entry, the address alone, asking to wait 9 s; the user in the Authorization header only; checked at the vendor's answer", async () => {
    const before = vendor.requests.length;
    const address = addressWith("valid");
    assert.deepEqual(await verifalia.verifyEmail({ address }), {
      verdict: "valid",
      checkedAt: new Date(NOW),
    });
    const body = JSON.stringify({ entries: [{ inputData: address }] });
    assert.deepEqual(requestsOf(before), [
      ["POST", "/v2.7/email-validations", { waitTime: "9000" }, body, BASIC],
    ]);
    const sent = vendor.requests[before];
    assert.ok(sent, "the job was created");
    const { authorization: _basic, ...others } = sent.headers;
    const seen = JSON.stringify(others).toLowerCase();
    for (const value of [USERNAME, PASSWORD, address, "cookie"]) {
      assert.ok(!seen.includes(value.toLowerCase()), `${value} in a header`);
    }
  });

  it("a job still running is read again by its id until done, never by its Location", async () => {
    const before = vendor.requests.length;
    vendor.answerNext({ ...running, headers: { location: `${vendor.origin}/elsewhere` } });
    vendor.answerNext(running);
    vendor.answerNext(finished("Risky", "ServerIsCatchAll"));
    assert.equal((await verify()).verdict, "catch_all");
    const read = ["GET", `/v2.7/email-validations/${JOB}`, { waitTime: "9000" }, "", BASIC];
    assert.deepEqual(requestsOf(before).slice(1), [read, read]);
  });

  it("a job not done within the budget, or after POLLS_MAX reads, is verifier_provider_error job_unfinished, never retried; a running job without its id off_shape", async () => {
    const unfinished = failsWith("verifier_provider_error", { reason: "job_unfinished" });
    let before = vendor.requests.length;
    for (let answer = 0; answer <= POLLS_MAX; answer += 1) vendor.answerNext(running);
    await assert.rejects(verify(), unfinished);
    assert.equal(vendor.requests.length - before, 1 + POLLS_MAX, "the creation and the reads");
    // The clock: the creation's answer comes 9.5 s in, with no time left to wait for another.
    const times = [NOW, NOW, NOW + BUDGET_MS - 500];
    const late = bound(onVendor(vendor.origin, () => times.shift() ?? NOW + BUDGET_MS));
    before = vendor.requests.length;
    vendor.answerNext(running);
    await assert.rejects(verify(late), unfinished);
    assert.equal(vendor.requests.length - before, 1, "no read past the budget");
    const offShape = failsWith("verifier_provider_error", { reason: "off_shape" });
    vendor.answerNext({ status: 202, body: { overview: { id: "../../elsewhere" } } });
    await assert.rejects(verify(), offShape);
    vendor.answerNext({ status: 202, body: {} });
    await assert.rejects(verify(), offShape);
  });

  it("each row of the mapping table: a catch-all server is catch_all, never valid; a full mailbox, a disposable or honeypot domain risky; else the classification", async () => {
    await assertVerdicts(verifalia, vendor, [
      ["deliverable", finished("Deliverable", "Success"), "valid"],
      ["catch-all", finished("Risky", "ServerIsCatchAll"), "catch_all"],
      ["catch-all, deliverable", finished("Deliverable", "ServerIsCatchAll"), "catch_all"],
      ["full mailbox", finished("Unknown", "MailboxHasInsufficientStorage"), "risky"],
      ["disposable mailbox", finished("Undeliverable", "MailboxIsDea"), "risky"],
      ["disposable domain", finished("Risky", "DomainIsWellKnownDea"), "risky"],
      ["disposable exchanger", finished("Risky", "MailExchangerIsWellKnownDea"), "risky"],
      ["honeypot", finished("Risky", "MailExchangerIsHoneypot"), "risky"],
      ["risky", finished("Risky", "ServerDoesNotAllowMultipleRecipients"), "risky"],
      ["no mailbox", finished("Undeliverable", "MailboxDoesNotExist"), "invalid"],
      ["no domain", finished("Undeliverable", "DomainDoesNotExist"), "invalid"],
      ["timeout", finished("Unknown", "SmtpConnectionTimeout"), "unknown"],
      ["a custom classification", finished("Suspicious", "OverrideMatch"), "unknown"],
      ["an object's key as a status", finished("Deliverable", "toString"), "valid"],
    ]);
  });

  it("the codes: 402 the credits gone; 401 and 403 unauthorized; 429 the rate limit, on a read too; 500 with its status; not JSON, a job not completed, or no entry, the provider error", async () => {
    const fails = async (served: Answer[], code: string, details: Record<string, unknown>) => {
      for (const next of served) vendor.answerNext(next);
      await assert.rejects(verify(), failsWith(code, details), JSON.stringify(served));
    };
    await fails([{ status: 402 }], "verifier_allowance_spent", { status: 402 });
    await fails([{ status: 401 }], "verifier_unauthorized", { status: 401 });
    await fails([{ status: 403 }], "verifier_unauthorized", { status: 403 });
    await fails([{ status: 429 }], "verifier_rate_limited", { retryAfterSec: 1 });
    await fails([running, { status: 429 }], "verifier_rate_limited", { retryAfterSec: 1 });
    const provider = "verifier_provider_error";
    await fails([{ status: 500 }], provider, { status: 500 });
    await fails([{ status: 410 }], provider, { status: 410 });
    await fails([{ body: "<html>" }], provider, { status: 200, reason: "not_json" });
    const offShape = { reason: "off_shape" };
    await fails([finished("Deliverable", "Success", "Expired")], provider, offShape);
    await fails(
      [{ body: { overview: { status: "Completed" }, entries: { data: [] } } }],
      provider,
      offShape,
    );
    await fails([finished(null, "Success")], provider, offShape);
  });

  it("a redirect is never followed, an answer past 64 KiB never read whole, no answer within the 10 s budget given up, a refused connection: verifier_provider_error", async (t) => {
    await checkPattern(t, vendor, verify, { maxBytes: MAX_ANSWER_BYTES, timeoutMs: BUDGET_MS });
    assert.deepEqual([MAX_ANSWER_BYTES, BUDGET_MS], [64 * 1024, 10_000]);
    const closed = bound(onVendor(await closedOrigin()));
    await assert.rejects(
      verify(closed),
      failsWith("verifier_provider_error", { reason: "network", code: "ECONNREFUSED" }),
    );
  });

  it("no username, password or address in an error, a log line, the console or a metric label", async (t) => {
    const address = "quillmarsh.ada@quillmarsh-tide.example";
    const echo = { title: "Unauthorized", detail: `${USERNAME} ${PASSWORD} ${address}` };
    const served: Answer[][] = [
      [{ status: 429, body: echo }],
      [{ status: 402, body: echo }],
      [{ status: 401, body: echo }],
      [{ status: 500, body: echo }],
      [{ status: 302, headers: { location: `${vendor.origin}/?u=${USERNAME}&p=${PASSWORD}` } }],
      [{ body: `quillmarsh ${PASSWORD}` }],
      Array(POLLS_MAX + 1).fill(running),
    ];
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...served.map((next) => () => {
        for (const answer of next) vendor.answerNext(answer);
        return verifalia.verifyEmail({ address });
      }),
      () => closed.verifyEmail({ address }),
    ];
    const { errors, seen, logged, counted } = await traces(t, calls);
    assert.equal(errors.length, calls.length, "every call failed");
    assert.equal(logged, calls.length, "every failure was logged");
    assert.ok(counted > 0, "the calls were counted");
    const secrets = [USERNAME, PASSWORD, BASIC.slice(6), address, "quillmarsh", vendor.origin];
    assert.deepEqual(leaked(secrets, seen), []);
  });

  it("as a host starts it: the free plan's 25 a day unless VERIFALIA_ALLOWANCE sets one; not open data; VERIFALIA_USERNAME and VERIFALIA_PASSWORD required", async () => {
    const module = import.meta.resolve("../index.ts");
    const runs = [
      [
        { VERIFALIA_USERNAME: "", VERIFALIA_PASSWORD: "", VERIFALIA_ALLOWANCE: "" },
        25,
        "day",
        "config_invalid",
      ],
      [
        { VERIFALIA_USERNAME: USERNAME, VERIFALIA_PASSWORD: "", VERIFALIA_ALLOWANCE: "" },
        25,
        "day",
        "config_invalid",
      ],
      [
        {
          VERIFALIA_USERNAME: USERNAME,
          VERIFALIA_PASSWORD: PASSWORD,
          VERIFALIA_ALLOWANCE: "200/day",
        },
        200,
        "day",
        "created",
      ],
    ] as const;
    for (const [env, calls, per, created] of runs) {
      assert.deepEqual(await startedIn(module, "verifaliaAdapter", env), {
        openData: false,
        allowance: { calls, per },
        created,
      });
    }
  });
});
