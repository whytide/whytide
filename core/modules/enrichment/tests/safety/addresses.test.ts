// The safety cases of the email lookup (gamma-en-080, send path; docs/security.md "What an email may
// go to"), run by `pnpm -F enrichment test:safety` and not by `test`: the readers the email tasks
// send by answer an active address a verifier called valid and nothing else; a personal address of
// a lead in the UK, the EU or the EEA, or with no known country, is answered by neither reader while
// the owner's switch is off, and nothing is deleted, so switching it on answers it again; an address
// never sits on two persons, whatever its kind; a bounced address is never answered again and leaves
// a negative entry; and in the outcome tables only a verifier's valid on an address no other person
// holds keeps an address or commits credits. gamma-rf-040: an address the never-contact list holds is
// never kept, from a verifier or from the cache, and never charged; its person is stopped then.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  createLeadForPerson,
  linkPersonToCompany,
  suppressionOf,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { addSuppression, useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { addressOf, markBounced, workEmailOf } from "../../domain/lookup/addresses.ts";
import { OWN_SOURCES_REASONS, type TriedEntry } from "../../domain/lookup/constants.ts";
import { keyHashOf } from "../../domain/lookup/key.ts";
import {
  lookupSettlement,
  ownSourcesSettlement,
  reverifySettlement,
} from "../../domain/lookup/outcome.ts";
import { keepAddress } from "../../domain/lookup/points.ts";
import { prepareLookup } from "../../domain/lookup/prepare.ts";
import { requestLookup } from "../../domain/lookup/request.ts";
import { ids } from "../../ids.ts";
import {
  createCacheEntry,
  useEnrichmentClient,
  usePersonalEmailEuUk,
} from "../../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const WS = "wsp_enrichment_safety";
const principal = servicePrincipal("enrichment_safety");
const app = asRole("app");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
const AT = new Date("2026-11-13T10:00:00Z");
afterEach(() => usePersonalEmailEuUk(undefined));

/** A person of the workspace located at `locationText`, or nowhere. */
const personAt = (slug: string, locationText?: string) =>
  run(async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName: "Noor",
      ...(locationText !== undefined && { locationText }),
    };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    return person.id;
  });

type Point = {
  value: string;
  kind?: "work_email" | "personal_email";
  verification?: "valid" | "catch_all" | "risky" | "invalid" | "unknown";
  status?: "active" | "bounced" | "opted_out";
};
/** A contact point of the person, as a settle writes one. */
async function point(personId: string, values: Point): Promise<string> {
  const id = newId(ids.contact_point);
  const { value, kind = "work_email", verification = "valid", status = "active" } = values;
  await app.contactPoint.create({
    data: {
      id,
      workspaceId: WS,
      personId,
      kind,
      value,
      verification,
      status,
      verifiedAt: AT,
      sourceClass: "email_finder",
      provider: "fake",
      acquiredAt: AT,
      legalBasis: "legitimate_interest",
    },
  });
  return id;
}
const readers = (personId: string, contactPointId: string) =>
  run(async () => [
    (await workEmailOf(personId))?.contactPointId ?? null,
    await addressOf(contactPointId),
  ]);

test("only an active address a verifier called valid is ever answered: catch_all, risky, invalid, unknown, bounced and opted out never are, by workEmailOf or addressOf", async () => {
  const cases: [string, Point][] = [
    ["catch-all", { value: "a@example.com", verification: "catch_all" }],
    ["risky", { value: "b@example.com", verification: "risky" }],
    ["invalid", { value: "c@example.com", verification: "invalid" }],
    ["unknown", { value: "d@example.com", verification: "unknown" }],
    ["bounced", { value: "e@example.com", status: "bounced" }],
    ["opted-out", { value: "f@example.com", status: "opted_out" }],
  ];
  for (const [slug, values] of cases) {
    const personId = await personAt(`never-${slug}`, "Austin, United States");
    const id = await point(personId, values);
    assert.deepEqual(await readers(personId, id), [null, null], slug);
  }
  const personId = await personAt("valid-one", "Austin, United States");
  const id = await point(personId, { value: "g@example.com" });
  assert.deepEqual(await readers(personId, id), [id, "g@example.com"]);
});

test("a personal address of a lead in the UK, the EU or the EEA, or with no known country, is answered by neither reader while the switch is off, and again once it is on; a US lead's either way; a work address comes first", async () => {
  const places: [string, string | undefined, boolean][] = [
    ["uk", "London, United Kingdom", false],
    ["fr", "Paris, France", false],
    ["no", "Oslo, Norway", false],
    ["nowhere", undefined, false],
    ["us", "Austin, United States", true],
  ];
  const held: [string, string, string, boolean][] = [];
  for (const [slug, location, usedWhenOff] of places) {
    const personId = await personAt(`personal-${slug}`, location);
    const id = await point(personId, { value: `${slug}@gmail.com`, kind: "personal_email" });
    held.push([slug, personId, id, usedWhenOff]);
  }
  for (const [slug, personId, id, usedWhenOff] of held) {
    const expected = usedWhenOff ? [id, `${slug}@gmail.com`] : [null, null];
    assert.deepEqual(await readers(personId, id), expected, `${slug}, switch off`);
  }
  usePersonalEmailEuUk(true);
  for (const [slug, personId, id] of held) {
    assert.deepEqual(await readers(personId, id), [id, `${slug}@gmail.com`], `${slug}, switch on`);
  }
  const both = await personAt("both-kinds", "Austin, United States");
  await point(both, { value: "both@gmail.com", kind: "personal_email" });
  const work = await point(both, { value: "both@example.com" });
  assert.equal((await run(() => workEmailOf(both)))?.contactPointId, work);
});

test("one address never sits on two persons, whatever its kind: the database refuses the second row", async () => {
  const first = await personAt("holder-one");
  const second = await personAt("holder-two");
  await point(first, { value: "shared@example.com" });
  const taken = (error: unknown) => (error as { code?: unknown }).code === "P2002";
  await assert.rejects(
    point(second, { value: "shared@example.com", kind: "personal_email" }),
    taken,
  );
  await assert.rejects(
    point(first, { value: "shared@example.com", verification: "invalid" }),
    taken,
  );
  assert.equal(await app.contactPoint.count({ where: { value: "shared@example.com" } }), 1);
});

test("a bounced address is never answered again, and its key's email entry becomes a negative one", async () => {
  const personId = await personAt("bounced-later", "Austin, United States");
  const id = await point(personId, { value: "later@example.com" });
  await run(() =>
    createCacheEntry({
      kind: "email",
      personId,
      keyHash: "k".repeat(64),
      provider: "fake",
      at: AT,
      address: "later@example.com",
    }),
  );
  await run(() => markBounced(id, { at: AT }));
  assert.deepEqual(await readers(personId, id), [null, null]);
  const entries = await app.enrichmentCacheEntry.findMany({ where: { personId } });
  assert.deepEqual(
    entries.map(({ kind, value, reason }) => [kind, value, reason]),
    [["negative", null, "bounced"]],
  );
});

test("the outcome tables: no end but a verifier's valid on an address no other person holds keeps an address or commits credits; a re-verification never commits", () => {
  const ends = [
    { end: "valid", n: 1 },
    { end: "catch_all", n: 1 },
    { end: "not_verified", n: 1 },
    { end: "no_verifier" },
    { end: "exhausted" },
    { end: "failed", code: "activity_failed" },
  ] as const;
  const tried: TriedEntry[] = [
    { source: "email-verifier/fake", step: "verify", outcome: "invalid", code: null, ms: 1 },
  ];
  for (const ended of ends) {
    for (const holder of ["free", "other_person", "inactive", "suppressed"] as const) {
      const settled = lookupSettlement(ended, tried, holder);
      const keeps = ended.end === "valid" && holder === "free";
      assert.equal(settled.status === "found", keeps, `${ended.end}, ${holder}`);
      assert.equal(settled.cache === "email", keeps, `${ended.end}, ${holder}`);
      assert.equal(settled.credits, keeps ? "commit" : "release", `${ended.end}, ${holder}`);
      for (const reason of OWN_SOURCES_REASONS) {
        const own = ownSourcesSettlement(ended, holder, reason);
        assert.equal(own.status === "found", keeps, `${ended.end}, ${holder}, ${reason}`);
        assert.notEqual(own.credits, "commit", `${ended.end}, ${holder}, ${reason}`);
      }
    }
    for (const personal of [false, true]) {
      const settled = reverifySettlement(ended, personal);
      assert.equal(settled.credits, "none");
      assert.equal(settled.status === "found", ended.end === "valid");
      assert.equal(settled.domainStatus, ended.end === "catch_all" && !personal);
    }
  }
});

const USER = "usr_enrichment_safety";
/** A verified address as a settle keeps one, at AT. */
const kept = (address: string) =>
  ({
    address,
    kind: "work_email",
    sourceClass: "email_finder",
    provider: "fake",
    verifiedAt: AT,
  }) as const;
/** The person's lead, imported. */
const leadOf = async (personId: string) => {
  const source = { kind: "imported", ref: "imp_enrichment_safety" } as const;
  await run(() => createLeadForPerson({ personId, source }));
};

test("a blocked address is never kept or charged: a verifier's valid on an address the never-contact list holds, on every channel or on email, ends skipped_suppressed with no cache entry and its credits released, in a lookup or one of the lead's own sources; keepAddress writes no contact point, and the person is then stopped, their lead suppressed for an entry on every channel", async () => {
  const valid = { end: "valid", n: 1 } as const;
  const skipped = ["skipped_suppressed", "suppressed", null, "release"];
  const rowOf = ({ status, reason, cache, credits }: ReturnType<typeof lookupSettlement>) => [
    ...[status, reason, cache, credits],
  ];
  for (const given of [false, true]) {
    assert.deepEqual(rowOf(lookupSettlement(valid, [], "suppressed", given)), skipped);
  }
  for (const reason of OWN_SOURCES_REASONS) {
    assert.deepEqual(rowOf(ownSourcesSettlement(valid, "suppressed", reason)), skipped, reason);
  }
  for (const channel of ["all", "email"] as const) {
    const address = `noor.blocked-${channel}@example.com`;
    const personId = await personAt(`blocked-${channel}`, "Austin, United States");
    await leadOf(personId);
    await run(() => addSuppression({ kind: "person", value: address, channel, createdBy: USER }));
    const answer = await run(() => keepAddress(personId, kept(address)));
    assert.deepEqual([answer.holder, answer.contactPointId], ["suppressed", null], channel);
    assert.equal(await app.contactPoint.count({ where: { personId } }), 0, channel);
    const read = await run(() =>
      suppressionOf(personId, { newEnrollment: false, channel: "email" }),
    );
    assert.deepEqual(read, { suppressed: true, reason: "never_contact_person", channel }, channel);
    const lead = await app.lead.findFirstOrThrow({ where: { personId } });
    assert.equal(lead.outreachStatus === "suppressed", channel === "all", channel);
  }
});

test("a live cache entry of a blocked address ends the lookup at its prepare: skipped_suppressed, no contact point, nothing reserved, the entry left as it is", async () => {
  const address = "noor.haddad@cached-blocked.example";
  const personId = await run(async () => {
    const imported = { source: "import", provider: "csv" } as const;
    const profile = {
      linkedinUrl: "https://linkedin.com/in/cached-blocked",
      firstName: "Noor",
      lastName: "Haddad",
      locationText: "Austin, United States",
    };
    const { person } = await upsertPersonFromSource({ ...imported, profile });
    const company = { name: "Cached Blocked", domain: "cached-blocked.example" };
    const { company: stored } = await upsertCompany({ ...imported, company });
    await linkPersonToCompany({ personId: person.id, companyId: stored.id });
    return person.id;
  });
  const keyHash = keyHashOf("Noor", "Haddad", "cached-blocked.example");
  const at = new Date();
  await run(() =>
    createCacheEntry({ kind: "email", personId, keyHash, provider: "fake", at, address }),
  );
  await run(() => addSuppression({ kind: "person", value: address, createdBy: USER }));
  const { requestId } = await run(() => requestLookup({ personId, requestKey: "cached-blocked" }));
  // No credits client is bound: a reservation would throw.
  const loaded = { sources: [], verifiers: [], leftOut: [] };
  const plan = await run(() => prepareLookup(requestId, loaded, true));
  assert.deepEqual(plan, { settled: true, status: "skipped_suppressed" });
  const request = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: requestId } });
  assert.deepEqual(
    [request.status, request.reason, request.contactPointId, request.creditUsageId],
    ["skipped_suppressed", "suppressed", null, null],
  );
  assert.equal(await app.contactPoint.count({ where: { personId } }), 0);
  const entries = await app.enrichmentCacheEntry.findMany({ where: { keyHash } });
  assert.deepEqual(
    entries.map(({ kind, value }) => [kind, value]),
    [["email", address]],
  );
  const read = await run(() => suppressionOf(personId, { newEnrollment: false }));
  assert.deepEqual(read, { suppressed: true, reason: "never_contact_person" });
});
