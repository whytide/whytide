// The tomba adapter's mapping tests (../README.md "Tests"), offline: tombaEmailFinder() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the synthetic
// fixture of fixtures/ (shaped like Tomba's API page, never recorded) and recording each request. No
// vendor is called; the key and the secret are made up for the run. First the port's contract suite
// in that world; then the request, each row of the README's mapping table, the pattern's redirect,
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
import { tombaAdapter, tombaEmailFinder } from "../index.ts";

const KEY = `ta_${randomBytes(16).toString("hex")}`;
const SECRET = `ts_${randomBytes(16).toString("hex")}`;
const NOW = Date.parse("2026-11-13T00:00:00Z");
const DOMAIN = "copper-harbor.example";
const ADA = { firstName: "Ada", lastName: "Example", companyDomain: DOMAIN };
const GRACE = { firstName: "Grace", lastName: "Sample", companyDomain: DOMAIN };
const FOUND = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "found.json"), "utf8"));
/** found.json with `data` changed. */
const answer = (data: Record<string, unknown>): Answer => ({
  body: { ...FOUND, data: { ...FOUND.data, ...data } },
});
const verified = (status: string, accept_all = false) =>
  answer({ verification: { date: "2026-11-01", status }, accept_all });
const NOBODY = answer({ email: null, score: null, sources: [] });
const error = (status: number, message: string) => ({
  status,
  body: { errors: { code: status, message } },
});

const vendor = await startVendor(({ query }) => {
  if (query.first_name === "Ada") return { body: FOUND };
  if (query.first_name === "Grace") {
    return answer({ email: `grace@${DOMAIN}`, verification: { status: "valid" } });
  }
  return NOBODY;
});
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  tombaEmailFinder({
    origin,
    key: KEY,
    secret: SECRET,
    now: () => NOW,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const local = { port: emailFinderPort, name: tombaAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailFinderPort, implementation, { adapter: tombaAdapter.name });
const tomba = bound();

/** Tomba's answer for each of the contract's codes, by the status. */
const FAILURES: Readonly<Record<EmailFinderFailure, Answer>> = {
  finder_rate_limited: {
    ...error(429, "Too many requests"),
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
  },
  finder_allowance_spent: error(402, "Not enough credits"),
  finder_unauthorized: error(401, "Unauthorized"),
  finder_provider_error: error(PROVIDER_ERROR_STATUS, "Service unavailable"),
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
  return tomba.findEmail(input);
}
const found = (vendorVerdict?: string) => ({
  result: "found",
  address: `ada@${DOMAIN}`,
  ...(vendorVerdict ? { vendorVerdict } : {}),
});

describe("the tomba adapter against a local vendor", () => {
  it("sends Email Finder the domain, the first name and the last name, and nothing else; the key and the secret in their two headers only", async () => {
    const before = vendor.requests.length;
    assert.deepEqual(await tomba.findEmail(ADA), found());
    const requests = vendor.requests.slice(before);
    const query = { domain: DOMAIN, first_name: "Ada", last_name: "Example" };
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [["GET", "/v1/email-finder", query, ""]],
    );
    const { "x-tomba-key": key, "x-tomba-secret": secret, ...headers } = requests[0]?.headers ?? {};
    assert.deepEqual([key, secret], [KEY, SECRET]);
    assert.ok(!requests[0]?.url.includes(KEY) && !requests[0]?.url.includes(SECRET));
    const rest = JSON.stringify(headers).toLowerCase();
    for (const value of [KEY, SECRET, "authorization", "cookie", "ada", DOMAIN]) {
      assert.ok(!rest.includes(value.toLowerCase()), `${value} in another header`);
    }
  });

  it("Tomba's own check as the verdict: accept_all, or the accept_all flag, is catch_all, never valid; webmail and disposable risky; none, or one it does not document, no verdict", async () => {
    const rows = [
      [verified("valid"), "valid"],
      [verified("accept_all"), "catch_all"],
      [verified("valid", true), "catch_all"],
      [verified("webmail"), "risky"],
      [verified("disposable"), "risky"],
      [verified("invalid"), "invalid"],
      [verified("unknown"), "unknown"],
      [verified("maybe"), undefined],
      [answer({ verification: null, accept_all: null }), undefined],
    ] as const;
    for (const [next, verdict] of rows) {
      assert.deepEqual(await answering(next), found(verdict), JSON.stringify(next.body));
    }
  });

  it("no address is not_found: email null, no data", async () => {
    assert.deepEqual(await answering(NOBODY), { result: "not_found" });
    assert.deepEqual(await answering({ body: { data: null } }), { result: "not_found" });
  });

  it("an address in capitals is lower-cased; one at another domain is still found; one off the port's form is the provider error, unread", async () => {
    assert.deepEqual(await answering(answer({ email: `ADA@${DOMAIN}` })), found());
    const elsewhere = await answering(answer({ email: "ada@granite-orbit.example" }));
    assert.deepEqual(elsewhere, { result: "found", address: "ada@granite-orbit.example" });
    const offShape = failsWith("finder_provider_error", { reason: "off_shape" });
    await assert.rejects(answering(answer({ email: "ada at copper harbor" })), offShape);
    await assert.rejects(answering({ body: [FOUND] }), offShape);
  });

  it("a 429 is the rate limit, Retry-After's seconds, else 60 s; a 402 the credits gone; a 401 and a 403 unauthorized; a 400 and a 500 the provider error; not JSON, not_json", async () => {
    for (const [headers, retryAfterSec] of [
      [{}, 60],
      [{ "retry-after": "7" }, 7],
    ] as const) {
      const limited = failsWith("finder_rate_limited", { retryAfterSec });
      await assert.rejects(answering({ ...error(429, "Too many"), headers }), limited);
    }
    const spent = failsWith("finder_allowance_spent", { status: 402 });
    await assert.rejects(answering(error(402, "Not enough credits")), spent);
    for (const status of [401, 403]) {
      const refused = failsWith("finder_unauthorized", { status });
      await assert.rejects(answering(error(status, "Unauthorized")), refused);
    }
    for (const status of [400, 500]) {
      const failed = failsWith("finder_provider_error", { status });
      await assert.rejects(answering(error(status, "Bad")), failed);
    }
    const notJson = failsWith("finder_provider_error", { status: 200, reason: "not_json" });
    await assert.rejects(answering({ body: "<html>" }), notJson);
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, no answer within 30 s given up, a refused connection: finder_provider_error", async (t) => {
    await checkPattern(t, vendor, () => tomba.findEmail(ADA), {
      maxBytes: MAX_ANSWER_BYTES,
      timeoutMs: TIMEOUT_MS,
    });
    const closed = bound(onVendor(await closedOrigin()));
    const network = failsWith("finder_provider_error", { reason: "network", code: "ECONNREFUSED" });
    await assert.rejects(closed.findEmail(ADA), network);
  });

  it("no key, secret, name, domain or address in an error, a log line, the console or a metric label", async (t) => {
    const person = {
      firstName: "Quillmarsh",
      lastName: "Tidewater",
      companyDomain: "tide.example",
    };
    const echo = (status: number) => error(status, `${KEY} ${SECRET} quillmarsh@tide.example`);
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...[echo(429), echo(402), echo(401), echo(500)].map((next) => () => answering(next, person)),
      () => answering(answer({ email: `quillmarsh tidewater ${SECRET}` }), person),
      () => answering({ status: 302, headers: { location: `/?secret=${SECRET}` } }, person),
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
    assert.deepEqual(leaked([KEY, SECRET, "quillmarsh", "tidewater", "tide.example"], seen), []);
  });

  it("from the registry: the free plan's allowance, 25 a month, unless TOMBA_ALLOWANCE sets one; TOMBA_KEY and TOMBA_SECRET required at start", async () => {
    const startWith = (env: Record<string, string>) =>
      allowanceAtStart("tomba", "TOMBA_ALLOWANCE", env);
    const both = { TOMBA_KEY: KEY, TOMBA_SECRET: SECRET };
    const runs: Record<string, string>[] = [
      both,
      { ...both, TOMBA_ALLOWANCE: "500/day" },
      { ...both, TOMBA_ALLOWANCE: "lots" },
      { TOMBA_KEY: KEY, TOMBA_SECRET: "" },
      { TOMBA_KEY: "", TOMBA_SECRET: SECRET },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '{"calls":25,"per":"month"}',
      '{"calls":500,"per":"day"}',
      "config_invalid",
      "config_invalid",
      "config_invalid",
    ]);
  });
});
