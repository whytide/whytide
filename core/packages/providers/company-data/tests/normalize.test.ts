// What the adapters share (../README.md "Adapters"), on its own: the name, domain, LinkedIn link,
// country, text and count rules of ../normalize.ts, the task's normalize test, and ../answer.ts
// reading a vendor's answer, each answer made here, none fetched. The adapters' own tests read these
// rules through their vendors' answers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAppError } from "@whytide/platform";
import { z } from "zod";
import { exchange, missingVariable, shaped } from "../answer.ts";
import {
  companyPageOf,
  countOf,
  countryOf,
  cutText,
  domainOf,
  knownFacts,
  normalizeCompanyName,
  single,
} from "../normalize.ts";

describe("normalize.ts", () => {
  it("a name: case, accents, punctuation and the legal forms at its end, never the name itself", () => {
    const names = [
      ["Copper Harbor Labs Ltd.", "copper harbor labs"],
      ["COPPER HARBOR LABS LIMITED", "copper harbor labs"],
      ["Copper Harbor Labs, Inc.", "copper harbor labs"],
      ["  Copper   Harbor-Labs  ", "copper harbor labs"],
      ["Société Générale S.A.", "societe generale"],
      ["O’Brien & Co", "obrien"],
      ["Ｃｏｐｐｅｒ Ｈａｒｂｏｒ", "copper harbor"],
      ["Ltd Holdings Pty Ltd", "ltd holdings"],
      ["Inc. PLC", "inc"],
      ["Limited", "limited"],
      ["株式会社 Copper", "株式会社 copper"],
      ["", ""],
    ] as const;
    for (const [name, normalized] of names)
      assert.equal(normalizeCompanyName(name), normalized, name);
    assert.notEqual(
      normalizeCompanyName("Copper Harbor"),
      normalizeCompanyName("Copper Harbor Labs"),
    );
  });

  it("a website's host as the port keeps a domain; anything else none", () => {
    const sites = [
      ["https://www.Copper-Harbor.example/about?x=1", "copper-harbor.example"],
      ["  http://copper-harbor.example  ", "copper-harbor.example"],
      ["https://shop.copper-harbor.co.uk", "shop.copper-harbor.co.uk"],
      ["https://www.www.copper-harbor.example", undefined],
      ["ftp://copper-harbor.example", undefined],
      ["copper-harbor.example", undefined],
      ["https://127.0.0.1/", undefined],
      ["https://localhost:8080", undefined],
      ["not a url", undefined],
    ] as const;
    for (const [site, domain] of sites) assert.equal(domainOf(site), domain, site);
  });

  it("a text trimmed and cut, never inside a surrogate pair; an empty one none", () => {
    assert.equal(cutText("  Copper Harbor  ", 100), "Copper Harbor");
    assert.equal(cutText("Copper Harbor", 7), "Copper");
    assert.equal(cutText("a😀b", 2), "a");
    assert.equal(cutText("a😀b", 3), "a😀");
    assert.equal(cutText("   ", 10), undefined);
  });

  it("one distinct value or none; the facts known, or none", () => {
    assert.equal(single([undefined, "GB", "GB"]), "GB");
    assert.equal(single(["GB", "IE"]), undefined);
    assert.equal(single([undefined]), undefined);
    assert.deepEqual(knownFacts({ industry: undefined, country: "GB" }), { country: "GB" });
    assert.equal(knownFacts({ industry: undefined, country: undefined }), undefined);
  });

  it("a bare host, as Diffbot and People Data Labs give a website, read as https when the adapter allows it", () => {
    const sites = [
      ["copper-harbor.example", "copper-harbor.example"],
      ["www.Copper-Harbor.example/about", "copper-harbor.example"],
      ["https://www.copper-harbor.example", "copper-harbor.example"],
      ["ftp://copper-harbor.example", undefined],
      ["localhost:8080", undefined],
      ["not a website", undefined],
      [42, undefined],
    ] as const;
    for (const [site, domain] of sites) {
      assert.equal(domainOf(site, { bareHost: true }), domain, String(site));
    }
  });

  it("a LinkedIn company link on any LinkedIn host, with or without its scheme, in the port's one form; any other page none", () => {
    const page = "https://www.linkedin.com/company/copper-harbor-labs";
    const links = [
      ["https://uk.linkedin.com/company/copper-harbor-labs/about/", page],
      ["linkedin.com/company/copper-harbor-labs", page],
      ["http://www.linkedin.com/company/copper-harbor-labs?trk=x", page],
      ["linkedin.com/in/ada-example", undefined],
      ["linkedin.com/school/copper-harbor-academy", undefined],
      ["https://copper-harbor.example/company/copper", undefined],
      ["https://notlinkedin.com/company/copper", undefined],
      [null, undefined],
    ] as const;
    for (const [link, expected] of links) assert.equal(companyPageOf(link), expected, String(link));
  });

  it("a country's English name in any case as its code, ICU's or a vendor's; a name it cannot tell none; a count from its least", () => {
    const names = [
      ["United Kingdom", "GB"],
      ["united states of america", "US"],
      ["People's Republic of China", "CN"],
      ["Côte d'Ivoire", "CI"],
      ["SOUTH KOREA", "KR"],
      ["St. Lucia", "LC"],
      ["Trinidad & Tobago", "TT"],
      ["European Union", undefined],
      ["Atlantis", undefined],
      [7, undefined],
    ] as const;
    for (const [name, code] of names) assert.equal(countryOf(name), code, String(name));
    assert.equal(cutText(null, 10), undefined);
    assert.deepEqual(
      [countOf(5, 1), countOf(0, 1), countOf(0, 0), countOf(1.5, 1), countOf("5", 1)],
      [5, undefined, 0, undefined, undefined],
    );
  });
});

describe("answer.ts", () => {
  const NOW = Date.parse("2026-11-13T00:00:00Z");
  const options = { maxBytes: 64, retryAfterSec: 60, now: () => NOW };
  const answer = (body: string | null, init: ResponseInit) => () =>
    Promise.resolve(new Response(body, init));
  const failsWith = (code: string, details: unknown) => (error: unknown) => {
    assert.ok(isAppError(error), String(error));
    assert.deepEqual([error.code, error.details], [code, details]);
    assert.equal(error.cause, undefined, "no vendor error kept");
    return true;
  };

  it("a 2xx answer is its JSON; one that is not JSON, or longer than the bound, the provider error", async () => {
    assert.deepEqual(await exchange(answer('{"a":1}', { status: 200 }), options), { a: 1 });
    await assert.rejects(
      exchange(answer("<html>", { status: 200 }), options),
      failsWith("company_data_provider_error", { status: 200, reason: "not_json" }),
    );
    const long = { status: 200, headers: { "content-length": "65" } };
    await assert.rejects(
      exchange(answer("x".repeat(65), long), options),
      failsWith("company_data_provider_error", { status: 200, reason: "answer_too_large" }),
    );
  });

  it("a 429 waits Retry-After's seconds or date, at least one second, else the adapter's default", async () => {
    const waits = [
      ["120", 120],
      ["0", 1],
      [new Date(NOW + 90_000).toUTCString(), 90],
      [new Date(NOW - 90_000).toUTCString(), 1],
      ["soon", 60],
      [undefined, 60],
    ] as const;
    for (const [retryAfter, seconds] of waits) {
      const headers: Record<string, string> = retryAfter ? { "retry-after": retryAfter } : {};
      await assert.rejects(
        exchange(answer("", { status: 429, headers }), options),
        failsWith("company_data_rate_limited", { retryAfterSec: seconds }),
      );
    }
  });

  it("402, 401 and 403, any other status: their codes with the status, never the body", async () => {
    const statuses = [
      [402, "company_data_allowance_spent"],
      [401, "company_data_unauthorized"],
      [403, "company_data_unauthorized"],
      [404, "company_data_provider_error"],
      [500, "company_data_provider_error"],
    ] as const;
    for (const [status, code] of statuses) {
      await assert.rejects(
        exchange(answer('{"secret":"body"}', { status }), options),
        failsWith(code, { status }),
      );
    }
  });

  it("the status an adapter names for no match answers undefined, its body unread as JSON; without it, that status is the provider error", async () => {
    const none = { ...options, notFound: 404 };
    assert.equal(await exchange(answer("<html>", { status: 404 }), none), undefined);
    await assert.rejects(
      exchange(answer("x".repeat(65), { status: 404 }), none),
      failsWith("company_data_provider_error", { status: 404, reason: "answer_too_large" }),
    );
    await assert.rejects(
      exchange(answer("{}", { status: 410 }), none),
      failsWith("company_data_provider_error", { status: 410 }),
    );
  });

  it("the adapter's own reading of a failure first; when it has none, the shared one", async () => {
    const own = {
      ...options,
      failure: (status: number) => (status === 403 ? missingVariable("X", "y") : undefined),
    };
    await assert.rejects(
      exchange(answer("", { status: 403 }), own),
      failsWith("config_invalid", {
        block: "packages/providers",
        variables: ["X: required by the y adapter"],
      }),
    );
    await assert.rejects(
      exchange(answer("", { status: 401 }), own),
      failsWith("company_data_unauthorized", { status: 401 }),
    );
  });

  it("no answer: a network error by its short code only, a timeout by its reason", async () => {
    const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    await assert.rejects(
      exchange(() => Promise.reject(refused), options),
      failsWith("company_data_provider_error", { reason: "network", code: "ECONNREFUSED" }),
    );
    const odd = new TypeError("fetch failed", { cause: { code: "copper-harbor.example" } });
    await assert.rejects(
      exchange(() => Promise.reject(odd), options),
      failsWith("company_data_provider_error", { reason: "network" }),
    );
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    await assert.rejects(
      exchange(() => Promise.reject(timeout), options),
      failsWith("company_data_provider_error", { reason: "timeout" }),
    );
  });

  it("an answer off its shape is the provider error, its values never repeated", () => {
    assert.deepEqual(shaped(z.object({ a: z.number() }), { a: 1 }), { a: 1 });
    assert.throws(
      () => shaped(z.object({ a: z.number() }), { a: "copper-harbor.example" }),
      failsWith("company_data_provider_error", { reason: "off_shape" }),
    );
  });
});
