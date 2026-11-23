// The prospeo adapter's mapping tests (../README.md "Tests"), offline: prospeoEmailFinder() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the synthetic
// fixture of fixtures/ (shaped like Prospeo's documentation, never recorded) and recording each
// request. No vendor is called; the key is made up for the run. First the port's contract suite in
// that world; then the request, each row of the README's mapping table, the pattern's redirect,
// bound and timeout, and what a run leaves behind. The config's checks run in a child process.
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
  startVendor,
  traces,
  vendorWorld,
} from "../../tests/fixtures/vendor.ts";
import { MAX_ANSWER_BYTES, TIMEOUT_MS } from "../constants.ts";
import { prospeoAdapter, prospeoEmailFinder } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
const DOMAIN = "copper-harbor.example";
const ADA = { firstName: "Ada", lastName: "Example", companyDomain: DOMAIN };
const GRACE = { firstName: "Grace", lastName: "Sample", companyDomain: DOMAIN };
const FOUND = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "found.json"), "utf8"));
/** found.json with the person's `email` changed. */
const answer = (email: Record<string, unknown> | null): Answer => ({
  body: {
    ...FOUND,
    person: { ...FOUND.person, email: email && { ...FOUND.person.email, ...email } },
  },
});
const error = (status: number, error_code: string) => ({
  status,
  body: { error: true, error_code },
});

const vendor = await startVendor(({ body }) => {
  const { first_name } = (JSON.parse(body) as { data: { first_name: string } }).data;
  if (first_name === "Ada") return answer({ status: null });
  if (first_name === "Grace") return answer({ email: `grace@${DOMAIN}` });
  return error(400, "NO_MATCH");
});
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  prospeoEmailFinder({ origin, apiKey: KEY, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const local = { port: emailFinderPort, name: prospeoAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailFinderPort, implementation, { adapter: prospeoAdapter.name });
const prospeo = bound();

/** Prospeo's answer for each of the contract's codes: its 400s name the error in the body. */
const FAILURES: Readonly<Record<EmailFinderFailure, Answer>> = {
  finder_rate_limited: {
    ...error(429, "RATE_LIMITED"),
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
  },
  finder_allowance_spent: error(400, "INSUFFICIENT_CREDITS"),
  finder_unauthorized: error(400, "INVALID_API_KEY"),
  finder_provider_error: error(PROVIDER_ERROR_STATUS, "INTERNAL_ERROR"),
};
contractSuite(
  emailFinderPort,
  local,
  emailFinderCases(
    vendorWorld(
      vendor,
      {
        person: { person: ADA, address: `ada@${DOMAIN}` },
        checked: { person: GRACE, address: `grace@${DOMAIN}`, vendorVerdict: "valid" },
      },
      { firstName: "Nobody", lastName: "Known", companyDomain: DOMAIN },
      FAILURES,
    ),
  ),
);

async function answering(next: Answer, input: FindEmailInput = ADA) {
  vendor.answerNext(next);
  return prospeo.findEmail(input);
}
const found = (vendorVerdict?: string) => ({
  result: "found",
  address: `ada@${DOMAIN}`,
  ...(vendorVerdict ? { vendorVerdict } : {}),
});
const NOT_FOUND = { result: "not_found" };

describe("the prospeo adapter against a local vendor", () => {
  it("sends Enrich Person the first name, the last name and the company's website, with only_verified_email, and nothing else; the key in X-KEY only", async () => {
    const before = vendor.requests.length;
    assert.deepEqual(await prospeo.findEmail(ADA), found());
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query }) => [method, path, query]),
      [["POST", "/enrich-person", {}]],
    );
    assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), {
      only_verified_email: true,
      data: { first_name: "Ada", last_name: "Example", company_website: DOMAIN },
    });
    const { "x-key": apiKey, ...headers } = requests[0]?.headers ?? {};
    assert.equal(apiKey, KEY);
    assert.ok(!requests[0]?.url.includes(KEY) && !requests[0]?.body.includes(KEY));
    assert.equal(headers["content-type"], "application/json");
    const rest = JSON.stringify(headers).toLowerCase();
    for (const value of [KEY, "authorization", "cookie", "ada", DOMAIN]) {
      assert.ok(!rest.includes(value.toLowerCase()), `${value} in another header`);
    }
  });

  it("VERIFIED is valid; any other status, or none, no verdict", async () => {
    assert.deepEqual(await answering(answer({})), found("valid"));
    for (const status of ["UNVERIFIED", "CATCH_ALL", null]) {
      assert.deepEqual(await answering(answer({ status })), found(), String(status));
    }
  });

  it("nobody is not_found: NO_MATCH, no email, an email not revealed, no person", async () => {
    assert.deepEqual(await answering(error(400, "NO_MATCH")), NOT_FOUND);
    assert.deepEqual(await answering(answer(null)), NOT_FOUND);
    assert.deepEqual(await answering(answer({ email: null })), NOT_FOUND);
    const masked = answer({ email: "ada.*****@copper-harbor.example", revealed: false });
    assert.deepEqual(await answering(masked), NOT_FOUND);
    assert.deepEqual(await answering({ body: { error: false, person: null } }), NOT_FOUND);
  });

  it("an address in capitals is lower-cased; one at another domain is still found; one off the port's form is the provider error, unread", async () => {
    assert.deepEqual(await answering(answer({ email: `Ada@${DOMAIN}` })), found("valid"));
    const elsewhere = await answering(answer({ email: "ada@granite-orbit.example" }));
    const other = { result: "found", address: "ada@granite-orbit.example", vendorVerdict: "valid" };
    assert.deepEqual(elsewhere, other);
    const offShape = failsWith("finder_provider_error", { reason: "off_shape" });
    await assert.rejects(answering(answer({ email: "ada.*****@copper-harbor.example" })), offShape);
    await assert.rejects(answering({ body: [FOUND] }), offShape);
  });

  it("INSUFFICIENT_CREDITS is the credits gone; INVALID_API_KEY, a 401 and a 403 unauthorized; a 429 the rate limit, else 60 s; INVALID_DATAPOINTS, INTERNAL_ERROR and a 500 the provider error; not JSON, not_json", async () => {
    const spent = failsWith("finder_allowance_spent", { status: 400 });
    await assert.rejects(answering(error(400, "INSUFFICIENT_CREDITS")), spent);
    const badKey = failsWith("finder_unauthorized", { status: 400 });
    await assert.rejects(answering(error(400, "INVALID_API_KEY")), badKey);
    for (const status of [401, 403]) {
      const refused = failsWith("finder_unauthorized", { status });
      await assert.rejects(answering(error(status, "UNAUTHORIZED")), refused);
    }
    const limited = failsWith("finder_rate_limited", { retryAfterSec: 60 });
    await assert.rejects(answering({ status: 429, body: "Rate limit exceeded" }), limited);
    for (const [status, code] of [
      [400, "INVALID_DATAPOINTS"],
      [400, "INVALID_REQUEST"],
      [500, "INTERNAL_ERROR"],
    ] as const) {
      const failed = failsWith("finder_provider_error", { status });
      await assert.rejects(answering(error(status, code)), failed, code);
    }
    const notJson = failsWith("finder_provider_error", { status: 200, reason: "not_json" });
    await assert.rejects(answering({ body: "<html>" }), notJson);
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, no answer within 30 s given up, a refused connection: finder_provider_error", async (t) => {
    await checkPattern(t, vendor, () => prospeo.findEmail(ADA), {
      maxBytes: MAX_ANSWER_BYTES,
      timeoutMs: TIMEOUT_MS,
    });
    const closed = bound(onVendor(await closedOrigin()));
    const network = failsWith("finder_provider_error", { reason: "network", code: "ECONNREFUSED" });
    await assert.rejects(closed.findEmail(ADA), network);
  });

  it("no key, name, domain or address in an error, a log line, the console or a metric label", async (t) => {
    const person = {
      firstName: "Quillmarsh",
      lastName: "Tidewater",
      companyDomain: "tide.example",
    };
    const echo = (status: number, code: string) => ({
      status,
      body: { error: true, error_code: code, message: `${KEY} quillmarsh@tide.example` },
    });
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...[
        echo(429, "RATE"),
        echo(400, "INSUFFICIENT_CREDITS"),
        echo(400, "INVALID_API_KEY"),
        echo(500, "INTERNAL_ERROR"),
      ].map((next) => () => answering(next, person)),
      () => answering(answer({ email: `quillmarsh tidewater ${KEY}` }), person),
      () => answering({ status: 302, headers: { location: `/?key=${KEY}` } }, person),
      () => {
        vendor.answerNext({ silent: true });
        return slow.findEmail(person);
      },
      () => closed.findEmail(person),
    ];
    const { errors, seen, logged, counted } = await traces(t, calls);
    assert.equal(errors.length, calls.length, "every call failed");
    assert.equal(logged, calls.length, "every failure was logged");
    assert.ok(counted > 0, "the calls were counted");
    assert.deepEqual(leaked([KEY, "quillmarsh", "tidewater", "tide.example"], seen), []);
  });

  it("from the registry: the free plan's allowance, 75 a month, unless PROSPEO_ALLOWANCE sets one; PROSPEO_API_KEY required at start", async () => {
    const startWith = (env: Record<string, string>) =>
      allowanceAtStart("prospeo", "PROSPEO_ALLOWANCE", env);
    const runs: Record<string, string>[] = [
      { PROSPEO_API_KEY: KEY },
      { PROSPEO_API_KEY: KEY, PROSPEO_ALLOWANCE: "1000/month" },
      { PROSPEO_API_KEY: KEY, PROSPEO_ALLOWANCE: "lots" },
      { PROSPEO_API_KEY: "" },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '{"calls":75,"per":"month"}',
      '{"calls":1000,"per":"month"}',
      "config_invalid",
      "config_invalid",
    ]);
  });
});
