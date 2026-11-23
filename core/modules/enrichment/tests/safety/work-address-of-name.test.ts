// The safety cases of the work address of a name that is not a person yet (gamma-wr-080, send path;
// docs/security.md "A name with no person"), run by `pnpm -F enrichment test:safety`: a picked person
// no page keyed is only a name in the caller's step. The lookup asks the sources that need no person
// (the pattern's guesses and the finders), a verifier checks each candidate, and only a verifier's
// `valid` on an address the never-contact list does not hold and no other person holds makes the
// person, with the address as its key, and keeps the contact point. Any other end leaves nothing: no
// person, lead, contact point, request, cache entry, event or hash, and the credit is released. The
// gates are the lookup's own: no guess at a domain recorded catch-all, nothing asked of a finder with
// no verifier call left or the credits short. The name and the address are in no log line, event,
// request or credit key. The fakes stand in for the finder, the verifier and the credits.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// The fakes whatever the environment names: the providers' config reads them as it loads, below.
process.env.PROVIDER_EMAIL_VERIFIER = "fake";
process.env.PROVIDER_EMAIL_FINDER = "fake";

const contacts = await import("@whytide/contacts");
const { addSuppression, useHashSalt } = await import("@whytide/contacts/testing");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { emailFinderPort, emailVerifierPort, getAdapter } = await import("@whytide/providers");
const { keepAddress } = await import("../../domain/lookup/points.ts");
const { workAddressOfName } = await import("../../domain/lookup/name.ts");
const { useEmailLists: useLists } = await import("../../domain/lookup/sources.ts");
const { defineSource } = await import("../../domain/sources/define.ts");
await import("../../domain/sources/pattern.ts");
const { useLog } = await import("../../domain/log.ts");
const { useClock, useEnrichmentClient } = await import("../../testing/index.ts");

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
useEnrichmentClient(app);
const WS = "wsp_EnrichmentNameSafety";
const principal = platform.servicePrincipal("enrichment_safety");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
useClock(() => new Date("2026-11-19T10:00:00Z"));
const USER = "usr_enrichment_name";
const DOMAIN = "harborlane.example";
const FIRST = "Ines";
const LAST = "Moreau";
const ADDRESS = "ines.moreau@harborlane.example";
const KEY = "fco_NameSafety:2";

type Fake = { reset(): void; setAllowance(allowance: { calls: number; per: "day" }): void } & {
  readonly recordedCalls: readonly { readonly method: string; readonly input: unknown }[];
};
const verifier = (await getAdapter(emailVerifierPort, "fake")) as unknown as Fake & {
  verdictFor(address: string, verdict: string): void;
};
const finder = (await getAdapter(emailFinderPort, "fake")) as unknown as Fake & {
  notFoundFor(first: string, last: string, domain: string): void;
};

/** The credits' reservations, commits and releases, their keys, and whether the workspace is short. */
const credits = {
  reserved: [] as { idempotencyKey: string; subjectRef: string }[],
  /** The usage of each key, as the real service keeps it: a repeat of a key answers the old row. */
  usageOf: new Map<string, { id: string; open: boolean }>(),
  committed: 0,
  released: 0,
  short: false,
  down: false,
};
platform.bindCreditsClient({
  reserve: async ({ idempotencyKey, subjectRef }) => {
    if (credits.down) throw new Error("the credits service is down");
    if (credits.short) throw new platform.AppError(platform.creditsCodes.insufficient_credits);
    credits.reserved.push({ idempotencyKey, subjectRef });
    const repeat = credits.usageOf.get(idempotencyKey);
    if (repeat) return { usageId: repeat.id, credits: "1" };
    const id = `usage_${credits.reserved.length}`;
    credits.usageOf.set(idempotencyKey, { id, open: true });
    return { usageId: id, credits: "1" };
  },
  commit: async (usageId) => {
    const row = [...credits.usageOf.values()].find(({ id }) => id === usageId);
    if (row?.open !== true) throw new platform.AppError("credits_usage_not_open");
    row.open = false;
    credits.committed += 1;
    return { usageId, credits: "1" };
  },
  release: async (usageId) => {
    const row = [...credits.usageOf.values()].find(({ id }) => id === usageId);
    if (row) row.open = false;
    credits.released += 1;
  },
  balance: async () => assert.fail("no balance is read"),
  priceOf: async () => assert.fail("no price is read"),
});

/** The sources asked, by name; a source of a name proposes what `proposals` holds. */
const asked: string[] = [];
let proposals: string[] = [];
let failing = false;
defineSource({
  name: "test-name-guess",
  kind: "email",
  activityKind: "db",
  forName: true,
  provenance: { source: "pattern", provider: "test-name-guess" },
  run: async () => {
    asked.push("test-name-guess");
    if (failing) throw new platform.AppError("test_source_failed");
    return proposals.length === 0
      ? { found: false as const }
      : { found: true as const, candidates: proposals.map((address) => ({ address })) };
  },
});
// A source that needs a person: never asked for a name, whatever it proposes.
defineSource({
  name: "test-person-only",
  kind: "email",
  activityKind: "db",
  provenance: { source: "lead_reply", provider: "test-person-only" },
  run: async () => {
    asked.push("test-person-only");
    return { found: true as const, candidates: [{ address: ADDRESS }] };
  },
});
const only = (...sources: string[]) =>
  useLists({ sources, finders: ["fake"], verifiers: ["fake"] });

/** What the caller's function was handed, and what it does: makes the person with the address. */
const made: string[] = [];
let makeNothing = false;
let makeFails = false;
async function make(address: string): Promise<string | null> {
  made.push(address);
  if (makeFails) throw new Error("the caller's function failed");
  if (makeNothing) return null;
  const profile = { name: `${FIRST} ${LAST}`, email: address, companyName: "Harbor Lane" };
  const imported = { source: "import", provider: "csv" } as const;
  const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
  await contacts.createLeadForPerson({
    personId: person.id,
    source: { kind: "imported", ref: "imp_name_safety" },
  });
  return person.id;
}
const lookup = (names: { first?: string; last?: string; domain?: string; key?: string } = {}) =>
  workAddressOfName(
    {
      ...{ firstName: names.first ?? FIRST, lastName: names.last ?? LAST },
      ...{ domain: names.domain ?? DOMAIN, key: names.key ?? KEY },
    },
    { workspaceId: WS, tenant: run, make },
  );

beforeEach(() => {
  verifier.reset();
  finder.reset();
  asked.length = 0;
  made.length = 0;
  proposals = [ADDRESS];
  failing = false;
  makeNothing = false;
  makeFails = false;
  credits.reserved = [];
  credits.usageOf.clear();
  credits.committed = credits.released = 0;
  credits.short = credits.down = false;
  only("test-name-guess");
});

const verified = () =>
  verifier.recordedCalls
    .filter(({ method }) => method === "verifyEmail")
    .map(({ input }) => (input as { address: string }).address);
const found = () => finder.recordedCalls.filter(({ method }) => method === "findEmail");

/** Nothing of the name is left: no person, lead, contact point, request, cache entry, hash or event. */
async function assertNothingLeft(label: string): Promise<void> {
  const counts = {
    person: await app.person.count(),
    lead: await app.lead.count(),
    contactPoint: await app.contactPoint.count(),
    request: await app.enrichmentRequest.count(),
    cache: await app.enrichmentCacheEntry.count(),
    hash: await app.personEmailHash.count(),
    events: await app.outboxEntry.count({ where: { workspaceId: WS } }),
  };
  assert.deepEqual(
    counts,
    { person: 0, lead: 0, contactPoint: 0, request: 0, cache: 0, hash: 0, events: 0 },
    label,
  );
}

test("only a verifier's valid makes the person: the caller's function is handed the address after the verifier said valid, the contact point is the person's, charged once, and one cache entry and the pattern's count follow", async () => {
  only("pattern");
  const result = await lookup();
  assert.equal(result.status, "found");
  assert.deepEqual([verified(), made], [[ADDRESS], [ADDRESS]]);
  const person = await app.person.findFirstOrThrow({});
  const point = await app.contactPoint.findFirstOrThrow({});
  assert.deepEqual(
    [point.personId, point.value, point.kind, point.verification, point.status, point.sourceClass],
    [person.id, ADDRESS, "work_email", "valid", "active", "pattern"],
  );
  assert.deepEqual(result.status === "found" && result.personId, person.id);
  assert.equal(await app.lead.count(), 1);
  assert.equal(await app.enrichmentCacheEntry.count({ where: { kind: "email" } }), 1);
  assert.equal(await app.enrichmentRequest.count(), 0, "a lookup for a name is no request");
  const patterns = await app.emailDomainPattern.findMany({});
  assert.deepEqual(
    patterns.map(({ domain, pattern, verifiedCount }) => [domain, pattern, verifiedCount]),
    [[DOMAIN, "{first}.{last}", 1]],
  );
  assert.deepEqual([credits.reserved.length, credits.committed, credits.released], [1, 1, 0]);
});

test("any other verdict, and no answer, leave nothing: no person, lead, contact point, request, cache entry, hash or event, the credit released, and the caller's function never called", async () => {
  for (const verdict of ["invalid", "risky", "unknown", "catch_all"] as const) {
    verifier.reset();
    credits.reserved = [];
    credits.committed = credits.released = 0;
    verifier.verdictFor(ADDRESS, verdict);
    const result = await lookup();
    assert.equal(result.status, "none", verdict);
    assert.deepEqual(made, [], verdict);
    await assertNothingLeft(verdict);
    assert.deepEqual([credits.reserved.length, credits.committed, credits.released], [1, 0, 1]);
  }
  credits.reserved = [];
  credits.committed = credits.released = 0;
  // The catch_all verdict recorded the domain: a domain with no such row is asked again.
  await app.emailDomainStatus.deleteMany({});
  proposals = [];
  assert.deepEqual(await lookup(), { status: "none", reason: "no_result" });
  await assertNothingLeft("no source answered");
  assert.deepEqual([credits.reserved.length, credits.committed, credits.released], [1, 0, 1]);
  failing = true;
  assert.deepEqual(await lookup({ key: "fco_NameSafety:3" }), {
    status: "none",
    reason: "provider_error",
  });
  await assertNothingLeft("the only source failed");
  assert.equal(credits.committed, 0);
});

test("a catch_all verdict records the domain, whose row holds no name and no address, and the next lookup there asks no source and no verifier", async () => {
  verifier.verdictFor(ADDRESS, "catch_all");
  assert.deepEqual(await lookup(), { status: "none", reason: "catch_all" });
  const statuses = await app.emailDomainStatus.findMany({});
  assert.deepEqual(
    statuses.map(({ domain, catchAll }) => [domain, catchAll]),
    [[DOMAIN, true]],
  );
  const stored = JSON.stringify(statuses).toLowerCase();
  for (const word of ["ines", "moreau", "@"]) assert.ok(!stored.includes(word), word);
  verifier.reset();
  asked.length = 0;
  credits.reserved = [];
  assert.deepEqual(await lookup({ key: "fco_NameSafety:3" }), {
    status: "none",
    reason: "catch_all",
  });
  assert.deepEqual([asked, verified(), credits.reserved.length], [[], [], 0]);
});

test("a domain recorded catch-all gets no guess: the pattern source, the finders and the verifiers are not asked and nothing is reserved", async () => {
  await app.emailDomainStatus.create({
    data: {
      ...{ id: "eds_name_safety", domain: DOMAIN, catchAll: true, provider: "fake" },
      ...{ checkedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) },
    },
  });
  only("pattern", "email-finder", "test-name-guess");
  assert.deepEqual(await lookup(), { status: "none", reason: "catch_all" });
  assert.deepEqual([asked, found(), verified(), credits.reserved.length], [[], [], [], 0]);
  await assertNothingLeft("catch-all domain");
});

test("an address on the never-contact list is kept nowhere: no person, no hash, no contact point, no cache entry, the credit released", async () => {
  await run(() => addSuppression({ kind: "person", value: ADDRESS, createdBy: USER }));
  const events = await app.outboxEntry.count({ where: { workspaceId: WS } });
  const result = await lookup();
  assert.deepEqual(result, { status: "none", reason: "suppressed" });
  assert.equal(await app.person.count(), 0);
  assert.equal(await app.lead.count(), 0);
  assert.equal(await app.contactPoint.count(), 0);
  assert.equal(await app.personEmailHash.count(), 0);
  assert.equal(await app.enrichmentCacheEntry.count(), 0);
  assert.equal(await app.outboxEntry.count({ where: { workspaceId: WS } }), events);
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
});

test("an address another person holds is kept for no second person, held as a hash or as a contact point: nothing made, the credit released", async () => {
  const holder = await run(async () => {
    const imported = { source: "import", provider: "csv" } as const;
    const profile = { name: "Marta Holder", email: ADDRESS, companyName: "Harbor Lane" };
    return (await contacts.upsertPersonFromSource({ ...imported, profile })).person.id;
  });
  assert.deepEqual(await lookup(), { status: "none", reason: "held_by_other_person" });
  assert.equal(await app.person.count(), 1, "only the holder");
  assert.equal(await app.lead.count(), 0);
  assert.equal(await app.contactPoint.count(), 0);
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
  // The same address as another person's contact point, with no hash recorded for it.
  const other = "ines.moreau2@harborlane.example";
  proposals = [other];
  await run(async () => {
    await keepAddress(holder, {
      ...{ address: other, kind: "work_email", sourceClass: "email_finder", provider: "fake" },
      verifiedAt: new Date("2026-11-19T09:00:00Z"),
    });
  });
  credits.committed = credits.released = 0;
  assert.deepEqual(await lookup({ key: "fco_NameSafety:3" }), {
    status: "none",
    reason: "held_by_other_person",
  });
  assert.equal(await app.person.count(), 1);
  assert.equal(await app.contactPoint.count({ where: { value: other } }), 1);
  assert.equal(await app.contactPoint.count({ where: { personId: { not: holder } } }), 0);
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
});

test("with no verifier call left nothing is asked of a finder or a source and nothing is reserved; with the credits short nothing is asked either", async () => {
  only("pattern", "email-finder", "test-name-guess");
  verifier.setAllowance({ calls: 0, per: "day" });
  assert.deepEqual(await lookup(), { status: "none", reason: "no_verifier_left" });
  assert.deepEqual([asked, found(), verified(), credits.reserved.length], [[], [], [], 0]);
  await assertNothingLeft("no verifier left");
  credits.short = true;
  verifier.reset();
  assert.deepEqual(await lookup(), { status: "none", reason: "insufficient_credits" });
  assert.deepEqual([asked, found(), verified()], [[], [], []]);
  await assertNothingLeft("credits short");
  credits.short = false;
  credits.down = true;
  await assert.rejects(lookup(), /the credits service is down/);
  assert.deepEqual([asked, found(), verified()], [[], [], []]);
});

test("only the sources that need no person are asked: a source of the lead's own, which needs one, is never asked for a name", async () => {
  only("test-person-only", "test-name-guess");
  proposals = [];
  assert.deepEqual(await lookup(), { status: "none", reason: "no_result" });
  assert.deepEqual(asked, ["test-name-guess"]);
  assert.deepEqual(verified(), []);
});

test("the vendors get what they get today: a finder the first name, the family name and the domain, a verifier the address; an address off the company's domain, one twice and one the finder judged invalid are never verified", async () => {
  only("email-finder");
  const result = await lookup();
  assert.equal(result.status, "found");
  assert.deepEqual(
    found().map(({ input }) => input),
    [{ firstName: FIRST, lastName: LAST, companyDomain: DOMAIN }],
  );
  assert.deepEqual(
    verifier.recordedCalls.map(({ method, input }) => [method, input]),
    [["verifyEmail", { address: ADDRESS }]],
  );
});

test("a candidate off the company's domain, off the address's form or seen twice is never verified, and each of the others is checked once", async () => {
  const third = "ines.moreau3@harborlane.example";
  proposals = ["ines@mailbox.example", "not-an-address", third, third.toUpperCase(), ADDRESS];
  verifier.verdictFor(third, "invalid");
  verifier.verdictFor(ADDRESS, "invalid");
  const result = await lookup();
  assert.deepEqual(result, { status: "none", reason: "not_verified" });
  assert.deepEqual(verified(), [third, ADDRESS]);
  await assertNothingLeft("not verified");
});

test("the lookup is bound by ENRICHMENT_EMAIL_MAX_CANDIDATES across its sources, and a failing source goes on to the next with its code only", async () => {
  const logs = platform.collectLogs();
  useLog(platform.createLogger({ destination: logs.destination }));
  try {
    failing = true;
    only("test-name-guess", "pattern");
    for (const pattern of ["ines.moreau", "ines", "imoreau", "inesmoreau"]) {
      verifier.verdictFor(`${pattern}@${DOMAIN}`, "invalid");
    }
    assert.deepEqual(await lookup(), { status: "none", reason: "not_verified" });
    assert.equal(verified().length, 3, "the pattern's guesses stop at the bound");
    await assertNothingLeft("the bound");
    const text = logs.raw.join("\n");
    assert.ok(text.includes("test_source_failed"), "the failure is logged by its code");
    assert.ok(!/ines|moreau|harborlane/i.test(text), "no name, address or domain in a log line");
  } finally {
    useLog(undefined);
  }
});

test("the name and the address are in no log line, event, request, history or credit key at any end, and the credit's key names the found company and the place in the pick only", async () => {
  const logs = platform.collectLogs();
  useLog(platform.createLogger({ destination: logs.destination }));
  try {
    failing = true;
    await lookup({ key: "fco_NameSafety:1" });
    failing = false;
    verifier.verdictFor(ADDRESS, "invalid");
    await lookup({ key: "fco_NameSafety:2" });
    verifier.reset();
    await lookup({ key: "fco_NameSafety:3" });
  } finally {
    useLog(undefined);
  }
  const keys = JSON.stringify(credits.reserved).toLowerCase();
  assert.ok(!/ines|moreau/.test(keys), "no name in a credit key or its subject");
  assert.deepEqual(
    credits.reserved.map(({ idempotencyKey, subjectRef }) => [
      idempotencyKey.replace(/:[0-9a-f]{32}$/, ":<attempt>"),
      subjectRef,
    ]),
    [1, 2, 3].map((n) => [`enr:name:fco_NameSafety:${n}:<attempt>`, "fco_NameSafety"]),
  );
  assert.ok(!/ines|moreau/i.test(logs.raw.join("\n")), "a log line holds no name or address");
  const events = JSON.stringify(await app.outboxEntry.findMany({ where: { workspaceId: WS } }));
  assert.ok(!/ines|moreau|harborlane/i.test(events), "an event holds no name or address");
  assert.equal(await app.enrichmentRequest.count(), 0);
});

test("a caller that makes no person, or fails, leaves nothing and the credit is released: its failure is raised for the step's attempts", async () => {
  makeNothing = true;
  assert.deepEqual(await lookup(), { status: "none", reason: "not_made" });
  await assertNothingLeft("not made");
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
  makeNothing = false;
  makeFails = true;
  await assert.rejects(lookup({ key: "fco_NameSafety:3" }), /the caller's function failed/);
  await assertNothingLeft("the caller failed");
  assert.deepEqual([credits.committed, credits.released], [0, 2]);
});

test("no name, no domain or a key that holds a name ask nothing and reserve nothing", async () => {
  assert.deepEqual(await lookup({ first: "  " }), { status: "none", reason: "no_name" });
  assert.deepEqual(await lookup({ last: "" }), { status: "none", reason: "no_name" });
  assert.deepEqual(await lookup({ domain: " " }), { status: "none", reason: "no_domain" });
  await assert.rejects(lookup({ key: "Ines Moreau" }), /enrichment_input_invalid/);
  assert.deepEqual([asked, found(), verified(), credits.reserved.length], [[], [], [], 0]);
  await assertNothingLeft("nothing asked");
});

test("a step run again after its credit was released reserves a new credit: the key holds a part of the call, so the old, released row is not answered, and a valid address on the retry makes the person once", async () => {
  makeFails = true;
  await assert.rejects(lookup(), /the caller's function failed/);
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
  makeFails = false;
  const result = await lookup();
  assert.equal(result.status, "found");
  assert.equal(new Set(credits.reserved.map(({ idempotencyKey }) => idempotencyKey)).size, 2);
  assert.deepEqual([credits.committed, credits.released], [1, 1]);
  assert.equal(await app.person.count(), 1);
});
