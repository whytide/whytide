// The hunter adapter's mapping tests (../README.md "Tests"), offline: hunterEmailFinder() against a
// vendor of the test's own on 127.0.0.1 (../../tests/fixtures/vendor.ts), answering the synthetic
// fixture of fixtures/ (shaped like Hunter's documentation, never recorded) and recording each
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
import { hunterAdapter, hunterEmailFinder } from "../index.ts";

const KEY = `key${randomBytes(16).toString("hex")}`;
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
const error = (status: number, id: string) => ({
  status,
  body: { errors: [{ id, code: status, details: `A ${id}.` }] },
});

const vendor = await startVendor(({ query }) => {
  if (query.first_name === "Ada") return { body: FOUND };
  if (query.first_name === "Grace") {
    const verification = { date: "2026-11-01", status: "accept_all" };
    return answer({ email: `grace@${DOMAIN}`, accept_all: true, verification });
  }
  return NOBODY;
});
after(() => vendor.close());

const onVendor = (origin = vendor.origin, timeoutMs?: number) =>
  hunterEmailFinder({ origin, apiKey: KEY, now: () => NOW, ...(timeoutMs ? { timeoutMs } : {}) });
const local = { port: emailFinderPort, name: hunterAdapter.name, requires: [], create: onVendor };
const bound = (implementation = onVendor()) =>
  bindPort(emailFinderPort, implementation, { adapter: hunterAdapter.name });
const hunter = bound();

/** Hunter's answer for each of the contract's codes: its 403 the rate limit, its 429 the usage limit. */
const FAILURES: Readonly<Record<EmailFinderFailure, Answer>> = {
  finder_rate_limited: {
    ...error(403, "too_many_requests"),
    headers: { "retry-after": String(RETRY_AFTER_SEC) },
  },
  finder_allowance_spent: error(429, "usage_limit"),
  finder_unauthorized: error(401, "authentication_failed"),
  finder_provider_error: error(PROVIDER_ERROR_STATUS, "server_error"),
};
contractSuite(
  emailFinderPort,
  local,
  emailFinderCases(
    vendorWorld(
      vendor,
      {
        person: { person: ADA, address: `ada@${DOMAIN}` },
        checked: { person: GRACE, address: `grace@${DOMAIN}`, vendorVerdict: "catch_all" },
      },
      { firstName: "Nobody", lastName: "Known", companyDomain: DOMAIN },
      FAILURES,
    ),
  ),
);

async function answering(next: Answer, input: FindEmailInput = ADA) {
  vendor.answerNext(next);
  return hunter.findEmail(input);
}
const found = (vendorVerdict?: string) => ({
  result: "found",
  address: `ada@${DOMAIN}`,
  ...(vendorVerdict ? { vendorVerdict } : {}),
});
const NOT_FOUND = { result: "not_found" };

describe("the hunter adapter against a local vendor", () => {
  it("sends Email Finder the domain, the first name and the last name, and nothing else; the key in X-API-KEY only", async () => {
    const before = vendor.requests.length;
    assert.deepEqual(await hunter.findEmail(ADA), found());
    const requests = vendor.requests.slice(before);
    assert.deepEqual(
      requests.map(({ method, path, query, body }) => [method, path, query, body]),
      [
        [
          "GET",
          "/v2/email-finder",
          { domain: DOMAIN, first_name: "Ada", last_name: "Example" },
          "",
        ],
      ],
    );
    const { "x-api-key": apiKey, ...headers } = requests[0]?.headers ?? {};
    assert.equal(apiKey, KEY);
    assert.ok(!requests[0]?.url.includes(KEY), "never in the URL");
    const rest = JSON.stringify(headers).toLowerCase();
    for (const value of [KEY, "authorization", "cookie", "ada", DOMAIN]) {
      assert.ok(!rest.includes(value.toLowerCase()), `${value} in another header`);
    }
  });

  it("Hunter's own check as the verdict: accept_all, or the accept_all flag, is catch_all, never valid; webmail and disposable risky; none, or one it does not document, no verdict", async () => {
    const rows = [
      [verified("valid"), "valid"],
      [verified("accept_all"), "catch_all"],
      [verified("valid", true), "catch_all"],
      [verified("webmail"), "risky"],
      [verified("disposable"), "risky"],
      [verified("invalid"), "invalid"],
      [verified("unknown"), "unknown"],
      [verified("maybe"), undefined],
      [answer({ verification: null }), undefined],
    ] as const;
    for (const [next, verdict] of rows) {
      assert.deepEqual(await answering(next), found(verdict), JSON.stringify(next.body));
    }
  });

  it("no address is not_found: email null, no data; a 451, a person who claimed their data, too", async () => {
    assert.deepEqual(await answering(NOBODY), NOT_FOUND);
    assert.deepEqual(await answering({ body: { data: null } }), NOT_FOUND);
    assert.deepEqual(await answering(error(451, "claimed_email")), NOT_FOUND);
  });

  it("an address in capitals is lower-cased; one at another domain is still found; one off the port's form is the provider error, unread", async () => {
    assert.deepEqual(await answering(answer({ email: ` Ada@${DOMAIN.toUpperCase()} ` })), found());
    const elsewhere = await answering(answer({ email: "ada@granite-orbit.example" }));
    assert.deepEqual(elsewhere, { result: "found", address: "ada@granite-orbit.example" });
    const offShape = failsWith("finder_provider_error", { reason: "off_shape" });
    await assert.rejects(answering(answer({ email: "Ada Example <ada@x.example>" })), offShape);
    await assert.rejects(answering(answer({ email: 42 })), offShape);
    await assert.rejects(answering({ body: [FOUND] }), offShape);
  });

  it("a 403 is the rate limit, Retry-After's seconds or date, else 60 s; a 429 the usage limit; a 402 too; a 401 unauthorized; a 400 and a 500 the provider error; not JSON, not_json", async () => {
    const waits = [
      [{}, 60],
      [{ "retry-after": "5" }, 5],
      [{ "retry-after": new Date(NOW + 90_000).toUTCString() }, 90],
    ] as const;
    for (const [headers, retryAfterSec] of waits) {
      const limited = failsWith("finder_rate_limited", { retryAfterSec });
      await assert.rejects(answering({ ...error(403, "too_many_requests"), headers }), limited);
    }
    for (const status of [429, 402]) {
      const spent = failsWith("finder_allowance_spent", { status });
      await assert.rejects(answering(error(status, "usage_limit")), spent);
    }
    const refused = failsWith("finder_unauthorized", { status: 401 });
    await assert.rejects(answering(error(401, "authentication_failed")), refused);
    for (const status of [400, 404, 500]) {
      const failed = failsWith("finder_provider_error", { status });
      await assert.rejects(answering(error(status, "wrong_params")), failed);
    }
    const notJson = failsWith("finder_provider_error", { status: 200, reason: "not_json" });
    await assert.rejects(answering({ body: "<html>" }), notJson);
  });

  it("a redirect is never followed, an answer past 256 KiB never read whole, no answer within 30 s given up, a refused connection: finder_provider_error", async (t) => {
    await checkPattern(t, vendor, () => hunter.findEmail(ADA), {
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
    const echo = (status: number) => ({
      status,
      body: { errors: [{ id: "echo", code: status, details: `${KEY} quillmarsh@tide.example` }] },
    });
    const slow = bound(onVendor(vendor.origin, 50));
    const closed = bound(onVendor(await closedOrigin()));
    const calls = [
      ...[echo(403), echo(429), echo(401), echo(500)].map((next) => () => answering(next, person)),
      () => answering(answer({ email: `quillmarsh tidewater ${KEY}` }), person),
      () => answering({ status: 302, headers: { location: `/?api_key=${KEY}` } }, person),
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

  it("from the registry: the free plan's allowance, 50 a month, unless HUNTER_ALLOWANCE sets one; HUNTER_API_KEY required at start", async () => {
    const startWith = (env: Record<string, string>) =>
      allowanceAtStart("hunter", "HUNTER_ALLOWANCE", env);
    const runs: Record<string, string>[] = [
      { HUNTER_API_KEY: KEY },
      { HUNTER_API_KEY: KEY, HUNTER_ALLOWANCE: "2000/month" },
      { HUNTER_API_KEY: KEY, HUNTER_ALLOWANCE: "lots" },
      { HUNTER_API_KEY: "" },
    ];
    assert.deepEqual(await Promise.all(runs.map(startWith)), [
      '{"calls":50,"per":"month"}',
      '{"calls":2000,"per":"month"}',
      "config_invalid",
      "config_invalid",
    ]);
  });
});
