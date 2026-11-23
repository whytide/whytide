// The lookup's outcome tables (domain/lookup/outcome.ts, docs/flows.md "The settle"): for each end, the
// request's status and reason, the cache entry, the domain's status and the credits; why a lookup
// whose sources are done found nothing, from its steps; an address the lead gave, and a lookup of
// the lead's own sources (gamma-en-100); what counts for a domain's pattern (gamma-rf-030); a valid
// address the never-contact list holds (gamma-rf-040).
import assert from "node:assert/strict";
import { test } from "node:test";
import { countedPattern } from "../domain/email/patterns.ts";
import type { TriedEntry } from "../domain/lookup/constants.ts";
import {
  exhaustedReason,
  type LookupEnd,
  lookupSettlement,
  ownSourcesReasonOf,
  ownSourcesSettlement,
  reverifySettlement,
} from "../domain/lookup/outcome.ts";

const step = (
  step: TriedEntry["step"],
  outcome: string,
  code: string | null = null,
): TriedEntry => ({
  source: step === "verify" ? "email-verifier/fake" : "email-finder/fake",
  step,
  outcome,
  code,
  ms: 1,
});
const row = ({
  status,
  reason,
  errorCode,
  cache,
  domainStatus,
  credits,
  event,
}: ReturnType<typeof lookupSettlement>) => [
  status,
  reason,
  errorCode,
  cache,
  domainStatus,
  credits,
  event.slice("enrichment.".length),
];

test("a lookup's ends: found and committed, held, bounced or blocked, catch_all, not verified, no verifier, failed", () => {
  const verified = [step("find", "found"), step("candidate", "kept"), step("verify", "valid")];
  const cases: [LookupEnd, "free" | "other_person" | "inactive" | "suppressed", unknown[]][] = [
    [
      { end: "valid", n: 1 },
      "free",
      ["found", null, null, "email", false, "commit", "address_verified"],
    ],
    [
      { end: "valid", n: 1 },
      "other_person",
      ["not_found", "held_by_other_person", null, "negative", false, "release", "address_missing"],
    ],
    [
      { end: "valid", n: 1 },
      "inactive",
      ["not_found", "bounced", null, "negative", false, "release", "address_missing"],
    ],
    [
      { end: "valid", n: 1 },
      "suppressed",
      ["skipped_suppressed", "suppressed", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "catch_all", n: 1 },
      "free",
      ["not_found", "catch_all", null, "negative", true, "release", "address_missing"],
    ],
    [
      { end: "not_verified", n: 1 },
      "free",
      ["not_found", "not_verified", null, "negative", false, "release", "address_missing"],
    ],
    [
      { end: "no_verifier" },
      "free",
      ["waiting_allowance", "no_verifier_left", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "failed", code: "activity_timeout" },
      "free",
      ["failed", "provider_error", "activity_timeout", null, false, "release", "address_missing"],
    ],
  ];
  for (const [ended, holder, expected] of cases) {
    assert.deepEqual(
      row(lookupSettlement(ended, verified, holder)),
      expected,
      `${ended.end} ${holder}`,
    );
  }
});

test("a lookup whose sources are done: not verified, off the domain, a personal address waiting for consent, no result, or the provider error when no source answered", () => {
  const cases: [TriedEntry[], unknown[]][] = [
    [
      [step("find", "found"), step("candidate", "kept"), step("verify", "invalid")],
      ["not_found", "not_verified", null, "negative"],
    ],
    [
      [step("find", "found"), step("candidate", "vendor_invalid")],
      ["not_found", "not_verified", null, "negative"],
    ],
    [
      [step("find", "found"), step("candidate", "other_domain")],
      ["not_found", "other_domain", null, "negative"],
    ],
    [
      [step("find", "found"), step("candidate", "personal_needs_consent")],
      ["not_found", "personal_needs_consent", null, null],
    ],
    [
      [step("find", "not_found"), step("find", "failed", "finder_unauthorized")],
      ["not_found", "no_result", null, "negative"],
    ],
    [
      [
        step("find", "failed", "finder_unauthorized"),
        step("find", "allowance_spent", "finder_allowance_spent"),
      ],
      ["failed", "provider_error", "finder_allowance_spent", null],
    ],
    [[], ["failed", "provider_error", null, null]],
  ];
  for (const [tried, expected] of cases) {
    assert.deepEqual(
      row(lookupSettlement({ end: "exhausted" }, tried, "free")).slice(0, 4),
      expected,
    );
  }
  assert.deepEqual(exhaustedReason([step("find", "allowance_spent")]), {
    reason: "provider_error",
    code: null,
  });
});

test("a re-verification's ends: free; valid renews, catch_all records a work address's domain only, any other verdict leaves a negative entry, no verifier and a failure change nothing", () => {
  const cases: [LookupEnd, boolean, unknown[]][] = [
    [
      { end: "valid", n: 0 },
      false,
      ["found", null, null, "email", false, "none", "address_verified"],
    ],
    [
      { end: "catch_all", n: 0 },
      false,
      ["not_found", "catch_all", null, "negative", true, "none", "address_missing"],
    ],
    [
      { end: "catch_all", n: 0 },
      true,
      ["not_found", "catch_all", null, "negative", false, "none", "address_missing"],
    ],
    [
      { end: "not_verified", n: 0 },
      false,
      ["not_found", "not_verified", null, "negative", false, "none", "address_missing"],
    ],
    [
      { end: "no_verifier" },
      false,
      ["waiting_allowance", "no_verifier_left", null, null, false, "none", "address_missing"],
    ],
    [
      { end: "failed", code: "activity_failed" },
      false,
      ["failed", "provider_error", "activity_failed", null, false, "none", "address_missing"],
    ],
  ];
  for (const [ended, personal, expected] of cases) {
    assert.deepEqual(
      row(reverifySettlement(ended, personal)),
      expected,
      `${ended.end} ${personal}`,
    );
  }
});

test("an address the lead gave (a source with anyDomain) is kept as any other and released, never committed; a finder's is committed", () => {
  const verified = [step("find", "found"), step("candidate", "kept"), step("verify", "valid")];
  const valid = { end: "valid", n: 1 } as const;
  assert.deepEqual(row(lookupSettlement(valid, verified, "free", true)), [
    ...["found", null, null, "email", false, "release", "address_verified"],
  ]);
  assert.equal(lookupSettlement(valid, verified, "free", false).credits, "commit");
  assert.equal(lookupSettlement(valid, verified, "free").credits, "commit");
  assert.deepEqual(row(lookupSettlement(valid, verified, "other_person", true)).slice(0, 2), [
    "not_found",
    "held_by_other_person",
  ]);
});

test("a lookup of the lead's own sources: valid on a free address found and released, on a blocked one skipped_suppressed; any other end its plan's reason, no cache entry, released; catch_all on a work address records the domain", () => {
  const cases: [LookupEnd, "free" | "other_person" | "suppressed", string, unknown[]][] = [
    [
      { end: "valid", n: 1 },
      "free",
      "no_domain",
      ["found", null, null, "email", false, "release", "address_verified"],
    ],
    [
      { end: "valid", n: 1 },
      "other_person",
      "catch_all",
      ["not_found", "catch_all", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "valid", n: 1 },
      "suppressed",
      "insufficient_credits",
      ["skipped_suppressed", "suppressed", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "exhausted" },
      "free",
      "no_domain",
      ["not_found", "no_domain", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "not_verified", n: 1 },
      "free",
      "insufficient_credits",
      ["waiting_budget", "insufficient_credits", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "catch_all", n: 1 },
      "free",
      "insufficient_credits",
      ["waiting_budget", "insufficient_credits", null, null, true, "release", "address_missing"],
    ],
    [
      { end: "no_verifier" },
      "free",
      "catch_all",
      ["not_found", "catch_all", null, null, false, "release", "address_missing"],
    ],
    [
      { end: "failed", code: "activity_failed" },
      "free",
      "no_domain",
      ["not_found", "no_domain", null, null, false, "release", "address_missing"],
    ],
  ];
  for (const [ended, holder, reason, expected] of cases) {
    const own = ownSourcesReasonOf(reason) ?? assert.fail(reason);
    assert.deepEqual(
      row(ownSourcesSettlement(ended, holder, own)),
      expected,
      `${ended.end} ${reason}`,
    );
  }
  assert.deepEqual([null, "no_result", "not_verified", "catch_all"].map(ownSourcesReasonOf), [
    null,
    null,
    null,
    "catch_all",
  ]);
});

test("what counts for a domain's pattern: a new work address at the company's own domain whose local part fits the person's names; an address renewed on its holder or re-verified (not created), a personal one, one at a subdomain or another domain, one fitting no pattern, or no domain counts nothing", () => {
  const kept = (address: string, created = true, kind = "work_email") => ({
    address,
    kind,
    created,
  });
  const count = (k: ReturnType<typeof kept>, domain = "acme.example") =>
    countedPattern(k, domain, "Jane", "Doe");
  assert.equal(count(kept("jdoe@acme.example")), "{f}{last}");
  assert.equal(count(kept("Jane.Doe@ACME.example")), "{first}.{last}");
  assert.equal(count(kept("jdoe@acme.example", false)), null);
  assert.equal(count(kept("jdoe@acme.example", true, "personal_email")), null);
  assert.equal(count(kept("jdoe@mail.acme.example")), null);
  assert.equal(count(kept("jdoe@other.example")), null);
  assert.equal(count(kept("sales.team@acme.example")), null);
  assert.equal(count(kept("jdoe@acme.example"), ""), null);
});
