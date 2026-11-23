// The safety cases of the lead's own sources (gamma-en-100, send path; docs/security.md "What an
// email may go to"), run by `pnpm -F enrichment test:safety`: a lookup with no company domain, with a
// company domain recorded catch-all, or with too few credits asks only the sources with `anyDomain`
// (what the lead gave), in the list's order, and reserves nothing; with none of them listed, it ends
// as before, with the same reason. A list of the lead's own sources only reserves nothing. In the
// outcome tables an address the lead gave never commits a credit, and a lookup on the lead's own
// sources keeps an address only on a verifier's `valid` and commits nothing.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { linkPersonToCompany, upsertCompany, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  AppError,
  bindCreditsClient,
  creditsCodes,
  newId,
  type ReserveInput,
  servicePrincipal,
} from "@whytide/platform";
import type { TriedEntry } from "../../domain/lookup/constants.ts";
import {
  type Holder,
  type LookupEnd,
  lookupSettlement,
  ownSourcesSettlement,
} from "../../domain/lookup/outcome.ts";
import { prepareLookup } from "../../domain/lookup/prepare.ts";
import { requestLookup } from "../../domain/lookup/request.ts";
import type { LoadedEmail } from "../../domain/lookup/sources.ts";
import type { EmailSourceDefinition } from "../../domain/sources/define.ts";
import { ids } from "../../ids.ts";
import { useClock, useEnrichmentClient } from "../../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
useEnrichmentClient(app);
const WS = "wsp_enrichment_own_safety";
const principal = servicePrincipal("enrichment_safety");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
const AT = new Date("2026-11-14T10:00:00Z");
useClock(() => AT);

/** The credits' reservations asked for, and whether the workspace is short. */
const reserved: ReserveInput[] = [];
let short = false;
bindCreditsClient({
  reserve: async (input) => {
    if (short) throw new AppError(creditsCodes.insufficient_credits);
    reserved.push(input);
    return { usageId: `usage_${reserved.length}`, credits: "1" };
  },
  commit: async () => assert.fail("prepare never commits"),
  release: async () => assert.fail("prepare never releases"),
  balance: async () => assert.fail("prepare reads no balance"),
  priceOf: async () => assert.fail("prepare reads no price"),
});
beforeEach(() => {
  reserved.length = 0;
  short = false;
});

/** An email source of the list: the lead's own (`anyDomain`) or one at the company's domain. */
const source = (name: string, anyDomain: boolean): EmailSourceDefinition => ({
  name,
  kind: "email",
  activityKind: "db",
  ...(anyDomain && { anyDomain }),
  provenance: { source: anyDomain ? "lead_reply" : "pattern", provider: name },
  run: async () => assert.fail("prepare calls no source"),
});
/** The list in the production order, linkedin-contact-info second. */
const PRODUCTION = [
  source("reply", true),
  source("linkedin-contact-info", true),
  source("website", false),
  source("pattern", false),
  source("email-finder/hunter", false),
];
const loaded = (sources: EmailSourceDefinition[]): LoadedEmail => ({
  sources,
  verifiers: [{ name: "email-verifier/fake", adapter: {} as never }],
  leftOut: [],
});

/** Noor Haddad at a company with `domain`, or with none; a lookup asked for them. */
async function lookupFor(slug: string, domain?: string): Promise<string> {
  return run(async () => {
    const imported = { source: "import", provider: "csv" } as const;
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName: "Noor",
      lastName: "Haddad",
      locationText: "Austin, United States",
    };
    const { person } = await upsertPersonFromSource({ ...imported, profile });
    if (domain !== undefined) {
      const company = { name: `Company ${slug}`, domain };
      const { company: stored } = await upsertCompany({ ...imported, company });
      await linkPersonToCompany({ personId: person.id, companyId: stored.id });
    }
    const { requestId } = await requestLookup({ personId: person.id, requestKey: slug });
    return requestId;
  });
}
const prepare = (requestId: string, sources: EmailSourceDefinition[]) =>
  run(() => prepareLookup(requestId, loaded(sources), true));
const requestOf = (id: string) => app.enrichmentRequest.findUniqueOrThrow({ where: { id } });
/** The plan's sources by name, or how the lookup ended. */
const planned = (plan: Awaited<ReturnType<typeof prepare>>) =>
  plan.settled ? plan.status : plan.sources.map(({ source: name }) => name);

async function catchAll(domain: string): Promise<void> {
  const expiresAt = new Date(AT.getTime() + 86_400_000);
  await app.emailDomainStatus.create({
    data: {
      ...{ id: newId(ids.email_domain_status), domain, catchAll: true, provider: "fake" },
      ...{ checkedAt: AT, expiresAt },
    },
  });
}

test("no company domain, or one recorded catch-all: only the sources with anyDomain, in the list's order, nothing reserved, the reason kept for the settle; with none of them listed, the lookup ends not_found with that reason, as before", async () => {
  await catchAll("loose.example");
  for (const [slug, domain, reason] of [
    ["own-no-domain", undefined, "no_domain"],
    ["own-catch-all", "loose.example", "catch_all"],
  ] as const) {
    const requestId = await lookupFor(slug, domain);
    assert.deepEqual(planned(await prepare(requestId, PRODUCTION)), [
      "reply",
      "linkedin-contact-info",
    ]);
    const request = await requestOf(requestId);
    assert.deepEqual(
      [request.status, request.reason, request.creditUsageId],
      ["running", reason, null],
    );

    const without = await lookupFor(`${slug}-none`, domain);
    assert.equal(planned(await prepare(without, PRODUCTION.slice(2))), "not_found");
    const ended = await requestOf(without);
    assert.deepEqual([ended.status, ended.reason], ["not_found", reason]);
  }
  assert.deepEqual(reserved, []);
});

test("credits short: only the sources with anyDomain, nothing reserved, insufficient_credits kept for the settle; with none of them listed, waiting_budget as before", async () => {
  short = true;
  const requestId = await lookupFor("own-short", "blueharbor.example");
  assert.deepEqual(planned(await prepare(requestId, PRODUCTION)), [
    "reply",
    "linkedin-contact-info",
  ]);
  const request = await requestOf(requestId);
  assert.deepEqual(
    [request.status, request.reason, request.creditUsageId],
    ["running", "insufficient_credits", null],
  );

  const without = await lookupFor("own-short-none", "blueharbor.example");
  assert.equal(planned(await prepare(without, PRODUCTION.slice(2))), "waiting_budget");
  const ended = await requestOf(without);
  assert.deepEqual([ended.status, ended.reason], ["waiting_budget", "insufficient_credits"]);
});

test("a list of the lead's own sources only reserves nothing; a list with a source at the company's domain reserves before any call, the whole list planned and no reason kept", async () => {
  const own = await lookupFor("own-only", "blueharbor.example");
  assert.deepEqual(planned(await prepare(own, PRODUCTION.slice(0, 2))), [
    "reply",
    "linkedin-contact-info",
  ]);
  const ownRequest = await requestOf(own);
  assert.deepEqual(
    [ownRequest.status, ownRequest.reason, ownRequest.creditUsageId],
    ["running", null, null],
  );
  assert.deepEqual(reserved, []);

  const full = await lookupFor("own-full", "blueharbor.example");
  assert.deepEqual(
    planned(await prepare(full, PRODUCTION)),
    PRODUCTION.map(({ name }) => name),
  );
  const fullRequest = await requestOf(full);
  assert.deepEqual(
    [fullRequest.status, fullRequest.reason, fullRequest.creditUsageId],
    ["running", null, "usage_1"],
  );
  assert.deepEqual(
    reserved.map(({ action, idempotencyKey }) => [action, idempotencyKey]),
    [["enrichment.work_email", `enr:${full}:1`]],
  );
});

test("the outcome tables: an address the lead gave never commits; a lookup on the lead's own sources keeps an address only on a verifier's valid on a free address, commits nothing, and ends otherwise with its plan's reason", () => {
  const tried: TriedEntry[] = [];
  const ends: LookupEnd[] = [
    { end: "valid", n: 1 },
    { end: "catch_all", n: 1 },
    { end: "not_verified", n: 1 },
    { end: "no_verifier" },
    { end: "exhausted" },
    { end: "failed", code: "activity_failed" },
  ];
  const holders: Holder[] = ["free", "other_person", "inactive"];
  for (const ended of ends) {
    for (const holder of holders) {
      const keeps = ended.end === "valid" && holder === "free";
      const given = lookupSettlement(ended, tried, holder, true);
      assert.equal(given.status === "found", keeps, `given ${ended.end}, ${holder}`);
      assert.notEqual(given.credits, "commit", `given ${ended.end}, ${holder}`);
      for (const reason of ["no_domain", "catch_all", "insufficient_credits"] as const) {
        const own = ownSourcesSettlement(ended, holder, reason);
        const what = `${reason} ${ended.end}, ${holder}`;
        assert.equal(own.status === "found", keeps, what);
        assert.notEqual(own.credits, "commit", what);
        if (!keeps) {
          const status = reason === "insufficient_credits" ? "waiting_budget" : "not_found";
          assert.deepEqual([own.status, own.reason, own.cache], [status, reason, null], what);
        }
      }
    }
  }
});
