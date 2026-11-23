// The safety cases of the lookup at find (gamma-wr-070, send path; docs/security.md "What an email may
// go to"), run by `pnpm -F enrichment test:safety`: an address a company's page printed with a person
// goes to a lookup with the trigger `found`. It is verified before any source is asked, and becomes
// a contact point only on a verifier's `valid`; an address off the company's own domain is never
// asked of a verifier; one on the never-contact list is kept nowhere and ends skipped_suppressed, one
// another person holds is kept nowhere; the address is held with the request while the lookup runs
// and is gone at every end, and is in no providers_tried entry, event or log line. The lookups of
// today (`jit_step`, `request`, `reverify`) plan as before. The steps are driven here as the
// workflow's walk drives them (workflows/lookup.ts); the worker's tests/enrichment-lookup.test.ts
// runs the workflow itself.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// The fakes whatever the environment names: the providers' config reads them as it loads, below.
process.env.PROVIDER_EMAIL_VERIFIER = "fake";
process.env.PROVIDER_FILES = "fake";

const contacts = await import("@whytide/contacts");
const { addSuppression, useHashSalt } = await import("@whytide/contacts/testing");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { emailVerifierPort, getAdapter } = await import("@whytide/providers");
const { findCandidates } = await import("../../domain/lookup/find.ts");
const { prepareLookup } = await import("../../domain/lookup/prepare.ts");
const { keyHashOf } = await import("../../domain/lookup/key.ts");
const { writeCache } = await import("../../domain/lookup/points.ts");
const { requestLookup } = await import("../../domain/lookup/request.ts");
const { settleLookupRun } = await import("../../domain/lookup/settle.ts");
const { loadEmail } = await import("../../domain/lookup/sources.ts");
const { verifyCandidate } = await import("../../domain/lookup/verify.ts");
const { defineSource } = await import("../../domain/sources/define.ts");
const { useLog } = await import("../../domain/log.ts");
const { useClock, useEmailLists, useEnrichmentClient } = await import("../../testing/index.ts");
type LookupEnd = import("../../domain/lookup/outcome.ts").LookupEnd;

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
useEnrichmentClient(app);
const WS = "wsp_EnrichmentPrintedSafety";
const principal = platform.servicePrincipal("enrichment_safety");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
const runs = { workspaceId: WS, tenant: run };
useClock(() => new Date("2026-11-19T10:00:00Z"));
const USER = "usr_enrichment_printed";
const DOMAIN = "harborlane.example";
const PRINTED = "ines.moreau@harborlane.example";

type Verifier = { verdictFor(address: string, verdict: string): void; reset(): void } & {
  readonly recordedCalls: readonly { readonly method: string; readonly input: unknown }[];
};
const verifier = (await getAdapter(emailVerifierPort, "fake")) as unknown as Verifier;

/** The credits' reservations, commits and releases, and whether the workspace is short. */
const credits = { reserved: 0, committed: 0, released: 0, reserveFails: false };
platform.bindCreditsClient({
  reserve: async () => {
    if (credits.reserveFails) throw new Error("the credits service is down");
    credits.reserved += 1;
    return { usageId: `usage_${credits.reserved}`, credits: "1" };
  },
  commit: async (usageId) => {
    credits.committed += 1;
    return { usageId, credits: "1" };
  },
  release: async () => {
    credits.released += 1;
  },
  balance: async () => assert.fail("no balance is read"),
  priceOf: async () => assert.fail("no price is read"),
});

/** The sources asked, by name: a source at the company's domain that proposes a fixed address. */
const asked: string[] = [];
let proposed: string | null = null;
defineSource({
  name: "test-guess",
  kind: "email",
  activityKind: "db",
  provenance: { source: "pattern", provider: "test-guess" },
  run: async () => {
    asked.push("test-guess");
    return proposed === null
      ? { found: false as const }
      : { found: true as const, candidates: [{ address: proposed }] };
  },
});
useEmailLists({ sources: ["test-guess"], finders: [], verifiers: ["fake"] });

beforeEach(() => {
  credits.reserveFails = false;
  verifier.reset();
  asked.length = 0;
  proposed = null;
  credits.reserved = credits.committed = credits.released = 0;
});

let counter = 0;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** A person at a company with `domain`; a lead for them, so that a block can stop them. */
async function personAt(domain: string | null = DOMAIN): Promise<string> {
  counter += 1;
  return run(async () => {
    const imported = { source: "import", provider: "csv" } as const;
    const profile = {
      linkedinUrl: `https://linkedin.com/in/printed-${counter}`,
      // A last name of its own: a lookup's cache entry is the name's and the domain's.
      ...{ firstName: "Ines", lastName: `Moreau${LETTERS[counter]}` },
      locationText: "Austin, United States",
    };
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    if (domain !== null) {
      const { company } = await contacts.upsertCompany({
        ...imported,
        company: { name: `Harbor Lane ${counter}`, domain },
      });
      await contacts.linkPersonToCompany({ personId: person.id, companyId: company.id });
    }
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_printed_safety" },
    });
    return person.id;
  });
}

/** The lookup at find asked for the person, with the address when given. */
async function ask(personId: string, address?: string): Promise<string> {
  const { requestId } = await run(() =>
    requestLookup({
      ...{ personId, requestKey: `found:${personId}`, trigger: "found" },
      ...(address !== undefined && { address }),
    }),
  );
  return requestId;
}
const requestOf = (id: string) => app.enrichmentRequest.findUniqueOrThrow({ where: { id } });

/** The workflow's walk on the steps: prepare, each source's find, each candidate's verifier, settle. */
async function drive(requestId: string) {
  const loaded = await loadEmail();
  const plan = await run(() => prepareLookup(requestId, loaded, true));
  const sources: string[] = plan.settled ? [] : plan.sources.map(({ source }) => source);
  if (plan.settled) return { status: plan.status, sources };
  let ended: LookupEnd = { end: "exhausted" };
  walk: for (const entry of plan.sources) {
    const { kept } = await findCandidates(runs, { requestId, source: entry.source });
    for (const n of kept) {
      const turn = await verifyCandidate(runs, { requestId, n, verifier: plan.verifiers[0] ?? "" });
      if (turn.outcome === "valid") {
        ended = { end: "valid", n };
        break walk;
      }
      if (turn.outcome === "catch_all" && !turn.personal) {
        ended = { end: "catch_all", n };
        break walk;
      }
    }
  }
  const settled = await settleLookupRun(runs, { requestId, ended });
  return { status: settled.status, sources };
}
const verified = () =>
  verifier.recordedCalls
    .filter(({ method }) => method === "verifyEmail")
    .map(({ input }) => (input as { address: string }).address);

test("the trigger `found` is a lookup of the person as `request` is: queued with its key and event; the address is held with the request, and one asked with another trigger is refused", async () => {
  const personId = await personAt();
  const requestId = await ask(personId, PRINTED);
  const row = await requestOf(requestId);
  assert.deepEqual([row.trigger, row.status, row.printedAddress], ["found", "queued", PRINTED]);
  const events = await app.outboxEntry.findMany({ where: { workspaceId: WS } });
  assert.equal(
    events.filter(({ eventName }) => eventName === "enrichment.lookup_requested").length,
    1,
  );
  assert.ok(!JSON.stringify(events).includes("harborlane"), "no address in an event");
  const other = await personAt();
  for (const trigger of ["jit_step", "request"] as const) {
    await assert.rejects(
      run(() =>
        requestLookup({ personId: other, requestKey: `t:${trigger}`, trigger, address: PRINTED }),
      ),
      /enrichment_input_invalid/,
    );
  }
  await assert.rejects(
    run(() =>
      requestLookup({
        personId: other,
        requestKey: "bad",
        trigger: "found",
        address: "not-an-address",
      }),
    ),
    /enrichment_input_invalid/,
  );
  assert.equal((await requestOf(await ask(other))).trigger, "found");
});

test("the printed address is verified before any source is asked, and on valid it is the person's work address, charged: no source asked, the contact point's class names the page", async () => {
  const personId = await personAt();
  const requestId = await ask(personId, PRINTED);
  const { status, sources } = await drive(requestId);
  assert.deepEqual([status, sources[0]], ["found", "printed"]);
  assert.deepEqual(verified(), [PRINTED]);
  assert.deepEqual(asked, [], "a valid printed address ends the lookup before any source");
  const point = await app.contactPoint.findFirstOrThrow({ where: { personId } });
  assert.deepEqual(
    [point.value, point.kind, point.verification, point.status, point.sourceClass],
    [PRINTED, "work_email", "valid", "active", "page_printed"],
  );
  assert.deepEqual([credits.reserved, credits.committed, credits.released], [1, 1, 0]);
});

/** A negative cache entry for the person's name and the company's domain, as a lookup that found nothing leaves. */
async function cachedNegative(personId: string): Promise<void> {
  await run(async () => {
    const person = await contacts.getPerson(personId);
    const keyHash = keyHashOf(person.firstName ?? "", person.lastName ?? "", DOMAIN);
    const at = new Date("2026-11-19T09:00:00Z");
    await writeCache({
      kind: "negative",
      personId,
      keyHash,
      provider: "test",
      at,
      reason: "no_result",
    });
  });
}

test("a cached negative entry for the name and the domain does not end the lookup before the printed address: a valid one is kept, the sources are not asked", async () => {
  const personId = await personAt();
  await cachedNegative(personId);
  const requestId = await ask(personId, PRINTED);
  const { status, sources } = await drive(requestId);
  assert.deepEqual([status, sources], ["found", ["printed"]]);
  assert.deepEqual(verified(), [PRINTED]);
  assert.deepEqual(asked, []);
  const point = await app.contactPoint.findFirstOrThrow({ where: { personId } });
  assert.deepEqual(
    [point.value, point.verification, point.status, point.sourceClass],
    [PRINTED, "valid", "active", "page_printed"],
  );
  assert.deepEqual([credits.reserved, credits.committed, credits.released], [1, 1, 0]);
  const row = await requestOf(requestId);
  assert.equal(row.printedAddress, null);
});

test("a cached negative entry still ends the lookup once the printed address is not valid: nothing kept, no source asked, nothing charged", async () => {
  for (const verdict of ["invalid", "risky", "unknown"] as const) {
    verifier.reset();
    asked.length = 0;
    credits.reserved = credits.committed = credits.released = 0;
    proposed = "i.moreau@harborlane.example";
    const personId = await personAt();
    await cachedNegative(personId);
    verifier.verdictFor(PRINTED, verdict);
    const requestId = await ask(personId, PRINTED);
    const { status, sources } = await drive(requestId);
    assert.deepEqual([status, sources], ["not_found", ["printed"]], verdict);
    assert.deepEqual(verified(), [PRINTED], verdict);
    assert.deepEqual(asked, [], verdict);
    assert.equal(await app.contactPoint.count({ where: { personId } }), 0, verdict);
    assert.deepEqual([credits.committed, credits.reserved, credits.released], [0, 1, 1], verdict);
    assert.equal((await requestOf(requestId)).printedAddress, null, verdict);
  }
});

test("a lookup at find with no printed address and a cached negative entry still ends cached_negative, free, as before", async () => {
  const personId = await personAt();
  await cachedNegative(personId);
  const { status, sources } = await drive(await ask(personId));
  assert.deepEqual([status, sources, verified()], ["not_found", [], []]);
  assert.deepEqual([credits.reserved, credits.committed], [0, 0]);
});

test("only a verifier's valid keeps a printed address: invalid goes on to the sources, catch_all, risky and unknown keep nothing, and what is not valid is never charged", async () => {
  for (const verdict of ["invalid", "risky", "unknown", "catch_all"] as const) {
    verifier.reset();
    asked.length = 0;
    credits.reserved = credits.committed = credits.released = 0;
    const personId = await personAt();
    verifier.verdictFor(PRINTED, verdict);
    const requestId = await ask(personId, PRINTED);
    const { status } = await drive(requestId);
    assert.notEqual(status, "found", verdict);
    assert.equal(await app.contactPoint.count({ where: { personId } }), 0, verdict);
    assert.equal(credits.committed, 0, verdict);
    // catch_all ends the walk at the company's domain; the others go on to the sources.
    assert.deepEqual(asked, verdict === "catch_all" ? [] : ["test-guess"], verdict);
    const row = await requestOf(requestId);
    assert.equal(row.contactPointId, null, verdict);
  }
});

test("on invalid the lookup goes on and a source's address is verified and kept as before", async () => {
  const personId = await personAt();
  verifier.verdictFor(PRINTED, "invalid");
  proposed = "i.moreau@harborlane.example";
  const requestId = await ask(personId, PRINTED);
  const { status } = await drive(requestId);
  assert.equal(status, "found");
  assert.deepEqual(verified(), [PRINTED, proposed]);
  const point = await app.contactPoint.findFirstOrThrow({ where: { personId } });
  assert.deepEqual([point.value, point.sourceClass], [proposed, "pattern"]);
});

test("only an address at the company's own domain is taken: another domain, and a lookup with no company domain, ask no verifier for it and keep nothing", async () => {
  const personId = await personAt();
  const elsewhere = "ines.moreau@mailbox.example";
  const requestId = await ask(personId, elsewhere);
  const { status } = await drive(requestId);
  assert.notEqual(status, "found");
  assert.deepEqual(verified(), []);
  assert.equal(await app.contactPoint.count({ where: { personId } }), 0);
  const tried = JSON.stringify((await requestOf(requestId)).providersTried);
  assert.ok(tried.includes("other_domain"), "the drop is recorded by its name");
  const bare = await personAt(null);
  const bareId = await ask(bare, PRINTED);
  const ended = await drive(bareId);
  assert.deepEqual([ended.status, ended.sources], ["not_found", []]);
  assert.deepEqual(verified(), []);
});

test("a printed address on the never-contact list ends the lookup skipped_suppressed: nothing kept, no cache entry, the credits released", async () => {
  const personId = await personAt();
  await run(() => addSuppression({ kind: "person", value: PRINTED, createdBy: USER }));
  const requestId = await ask(personId, PRINTED);
  const { status } = await drive(requestId);
  assert.equal(status, "skipped_suppressed");
  assert.equal(await app.contactPoint.count({ where: { personId } }), 0);
  assert.equal(await app.enrichmentCacheEntry.count({ where: { personId } }), 0);
  assert.deepEqual([credits.committed, credits.released], [0, 1]);
  assert.equal((await requestOf(requestId)).printedAddress, null);
});

test("an address another person holds is kept nowhere for this one: not_found held_by_other_person, nothing charged", async () => {
  const holder = await personAt();
  await run(async () => {
    const { keepAddress } = await import("../../domain/lookup/points.ts");
    await keepAddress(holder, {
      ...{ address: PRINTED, kind: "work_email", sourceClass: "email_finder", provider: "fake" },
      verifiedAt: new Date("2026-11-19T09:00:00Z"),
    });
  });
  const personId = await personAt();
  const requestId = await ask(personId, PRINTED);
  const { status } = await drive(requestId);
  assert.equal(status, "not_found");
  assert.equal((await requestOf(requestId)).reason, "held_by_other_person");
  assert.equal(await app.contactPoint.count({ where: { personId } }), 0);
  assert.equal(await app.contactPoint.count({ where: { value: PRINTED } }), 1);
  assert.equal(credits.committed, 0);
});

test("the address is gone from the request at every end, and is in no providers_tried entry, event or log line", async () => {
  const logs = platform.collectLogs();
  const loaded = await loadEmail();
  useLog(platform.createLogger({ destination: logs.destination }));
  const ends: [string, () => Promise<string>][] = [
    ["found", async () => ask(await personAt(), PRINTED)],
    [
      "invalid",
      async () => {
        verifier.verdictFor(PRINTED, "invalid");
        return ask(await personAt(), PRINTED);
      },
    ],
    ["no domain", async () => ask(await personAt(null), PRINTED)],
    ["other domain", async () => ask(await personAt(), "ines@mailbox.example")],
  ];
  for (const [name, start] of ends) {
    verifier.reset();
    const requestId = await start();
    assert.equal((await requestOf(requestId)).printedAddress !== null, true, `${name}: held`);
    await drive(requestId);
    const row = await requestOf(requestId);
    assert.equal(row.printedAddress, null, `${name}: removed at the end`);
    assert.notEqual(row.status, "running", name);
    assert.ok(!JSON.stringify(row.providersTried).includes("@"), `${name}: providers_tried`);
  }
  // The ends before the lookup runs: cancelled while queued, and a prepare that fails for good.
  const queued = await ask(await personAt(), PRINTED);
  await settleLookupRun(runs, {
    requestId: queued,
    ended: { end: "failed", code: "activity_cancelled" },
  });
  assert.equal((await requestOf(queued)).printedAddress, null, "cancelled before prepare");
  credits.reserveFails = true;
  const broken = await ask(await personAt(), PRINTED);
  await assert.rejects(run(() => prepareLookup(broken, loaded, true)));
  assert.equal((await requestOf(broken)).printedAddress !== null, true, "held until the settle");
  await settleLookupRun(runs, { requestId: broken, ended: { end: "failed", code: "x" } });
  const failed = await requestOf(broken);
  assert.equal(failed.printedAddress, null, "prepare failed");
  assert.ok(!JSON.stringify(failed.providersTried).includes("@"));
  credits.reserveFails = false;
  const events = await app.outboxEntry.findMany({ where: { workspaceId: WS } });
  assert.ok(!JSON.stringify(events).includes("moreau"), "an event holds no address");
  assert.ok(!logs.raw.join("\n").includes("moreau"), "a log line holds no address");
});

test("a request that is not running when it is settled (cancelled before prepare, a prepare that failed) loses its printed address, and a settled one's stays null", async () => {
  for (const ended of [
    { end: "failed", code: "activity_cancelled" },
    { end: "failed", code: "enrichment_provider_error" },
    { end: "exhausted" },
  ] as const) {
    const requestId = await ask(await personAt(), PRINTED);
    assert.equal((await requestOf(requestId)).status, "queued");
    const settled = await settleLookupRun(runs, { requestId, ended });
    assert.equal(settled.status, "queued", ended.end);
    assert.equal((await requestOf(requestId)).printedAddress, null, JSON.stringify(ended));
    // Settled again, on a request that has ended: still null, nothing else changes.
    const again = await settleLookupRun(runs, { requestId, ended });
    assert.equal(again.status, settled.status);
    assert.equal((await requestOf(requestId)).printedAddress, null);
  }
  assert.equal(await app.contactPoint.count(), 0);
});

test("a lookup at find with no printed address plans as a `request` does: the sources only, no printed step; the lookups of today plan as before", async () => {
  proposed = null;
  const plans: string[][] = [];
  for (const trigger of ["found", "request", "jit_step"] as const) {
    const personId = await personAt();
    const { requestId } = await run(() =>
      requestLookup({ personId, requestKey: `plan:${trigger}-${personId}`, trigger }),
    );
    const plan = await run(async () => prepareLookup(requestId, await loadEmail(), true));
    assert.equal(plan.settled, false, trigger);
    plans.push(plan.settled ? [] : plan.sources.map(({ source }) => source));
  }
  assert.deepEqual(plans, [["test-guess"], ["test-guess"], ["test-guess"]]);
});
