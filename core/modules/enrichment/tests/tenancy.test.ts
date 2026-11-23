// test:tenancy for enrichment (docs/rules/security.md §3; core/packages/db README "Register a tenant
// table in the isolation test"): a run in workspaces A and B is two rows, each read by the module's
// readers in its own workspace only, even by the other workspace's ids; source_usage, the instance's
// counters, has no workspace and no personal column, and app may read, add and count on it but never
// delete a row or count below 0; every public command and query goes through the tenant client of the
// caller's run. The email lookup's tables (gamma-en-080): a contact point, a request and a cache
// entry in workspaces A and B, each read in its own workspace only; email_domain_statuses has no
// workspace and no personal column, nor has email_domain_patterns (gamma-rf-030), whose rows app may
// read, add and count on but never delete.
import assert from "node:assert/strict";
import test from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, sqlstate, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { writePattern } from "../domain/email/domain-pattern.ts";
import { erasePerson } from "../domain/erase.ts";
import { leadPhones } from "../domain/lead/phones.ts";
import { addressOf, markBounced, workEmailOf } from "../domain/lookup/addresses.ts";
import { requestLookup, requestReverification } from "../domain/lookup/request.ts";
import { keepPhone } from "../domain/phone/keep.ts";
import { lastRunOf, sourcesTried } from "../domain/readers.ts";
import { requestEnrichment } from "../domain/request.ts";
import { reserveCall } from "../domain/usage.ts";
import {
  createCacheEntry,
  createContactPoint,
  createRun,
  useEnrichmentClient,
} from "../testing/index.ts";

const db = withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const principal = servicePrincipal("enrichment_test");
const run = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
/** The runs made, by workspace: a reader is asked for each one's person and run in every workspace. */
const made: { personId: string; runId: string }[] = [];

isolationTest("enrichment_runs", {
  async createRow(workspaceId) {
    return run(workspaceId, async () => {
      const profile = {
        linkedinUrl: `https://linkedin.com/in/run-${made.length}`,
        firstName: "Noor",
      };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      const { runId } = await createRun({
        personId: person.id,
        trigger: "request",
        requestKey: "k",
      });
      made.push({ personId: person.id, runId });
      return { id: runId };
    });
  },
  async readAs(workspaceId) {
    return run(workspaceId, async () => {
      const seen: { id: string }[] = [];
      for (const { personId, runId } of made) {
        const last = await lastRunOf(personId);
        if (last !== null) seen.push({ id: last.runId });
        // A run of another workspace has no sources tried here.
        if (last === null) assert.deepEqual(await sourcesTried(runId), []);
      }
      return seen;
    });
  },
});

/** A person of the workspace, made under a slug of its own. */
const personIn = (workspaceId: string, slug: string) =>
  run(workspaceId, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    return person.id;
  });
const persons: string[] = [];
const AT = new Date("2026-11-13T10:00:00Z");

isolationTest("contact_points", {
  async createRow(workspaceId) {
    const personId = await personIn(workspaceId, `point-${persons.length}`);
    persons.push(personId);
    const kept = {
      kind: "work_email",
      sourceClass: "email_finder",
      provider: "fake",
      verifiedAt: AT,
    } as const;
    const { contactPointId } = await run(workspaceId, () =>
      createContactPoint(personId, { ...kept, address: `p${persons.length}@example.com` }),
    );
    return { id: contactPointId ?? "" };
  },
  async readAs(workspaceId) {
    return run(workspaceId, async () => {
      const seen: { id: string }[] = [];
      for (const personId of persons) {
        const found = await workEmailOf(personId);
        if (found === null) continue;
        assert.ok(await addressOf(found.contactPointId));
        seen.push({ id: found.contactPointId });
      }
      return seen;
    });
  },
});

const asked: string[] = [];
/** The request a key gives again in the workspace: its own, or none for another's person. */
const askAgain = async (personId: string) => {
  try {
    return (await requestLookup({ personId, requestKey: "k" })).requestId;
  } catch (error) {
    if (isAppError(error) && error.code === "enrichment_person_not_found") return null;
    throw error;
  }
};

isolationTest("enrichment_requests", {
  async createRow(workspaceId) {
    const personId = await personIn(workspaceId, `request-${asked.length}`);
    asked.push(personId);
    const { requestId } = await run(workspaceId, () =>
      requestLookup({ personId, requestKey: "k" }),
    );
    return { id: requestId };
  },
  async readAs(workspaceId) {
    return run(workspaceId, async () => {
      const seen: { id: string }[] = [];
      for (const personId of asked) {
        const requestId = await askAgain(personId);
        if (requestId !== null) seen.push({ id: requestId });
      }
      return seen;
    });
  },
});

isolationTest("enrichment_cache_entries", {
  async createRow(workspaceId) {
    const personId = await personIn(workspaceId, "cached");
    const keyHash = "k".repeat(64);
    const entry = { kind: "negative", personId, keyHash, provider: "fake", at: AT } as const;
    await run(workspaceId, () => createCacheEntry({ ...entry, reason: "no_result" } as const));
    const [row] = await asRole("app").enrichmentCacheEntry.findMany({ where: { workspaceId } });
    return { id: row?.id ?? "" };
  },
  // The read the prepare step makes, on the run's tenant client.
  readAs: (workspaceId) =>
    run(workspaceId, async () =>
      (
        await tenantClient.enrichmentCacheEntry.findMany({ where: { keyHash: "k".repeat(64) } })
      ).map(({ id }) => ({ id })),
    ),
});

test("email_domain_statuses, global: no workspace and no personal column; the pattern's three columns (gamma-en-085)", async () => {
  const columns = await asRole("owner").$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = 'email_domain_statuses' ORDER BY column_name`;
  assert.deepEqual(
    columns.map(({ column_name }) => column_name),
    [
      ...["catch_all", "checked_at", "domain", "expires_at", "id"],
      ...["pattern", "pattern_checked_at", "pattern_source", "provider"],
    ],
  );
});

test("email_domain_patterns, global: no workspace and no personal column; app reads, adds and counts but never deletes a row (gamma-rf-030)", async () => {
  const columns = await asRole("owner").$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = 'email_domain_patterns' ORDER BY column_name`;
  assert.deepEqual(
    columns.map(({ column_name }) => column_name),
    ["created_at", "domain", "last_verified_at", "pattern", "site_seen_at", "verified_count"],
  );
  const app = asRole("app");
  await run("wsp_patterns_a", () => writePattern("acme.example", "{f}{last}", "verified", AT));
  await run("wsp_patterns_b", () => writePattern("acme.example", "{f}{last}", "verified", AT));
  const [row] = await app.emailDomainPattern.findMany();
  assert.equal(row?.verifiedCount, 2);
  assert.equal(await sqlstate(app.$executeRaw`DELETE FROM email_domain_patterns`), "42501");
  assert.equal(await app.emailDomainPattern.count(), 1);
});

test("source_usage, the instance's counters: no workspace and no personal column; app reads, adds and counts but never deletes a row, nor counts below 0", async () => {
  const columns = await asRole("owner").$queryRaw<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = 'source_usage' ORDER BY column_name`;
  assert.deepEqual(
    columns.map(({ column_name }) => column_name),
    ["id", "period", "period_start", "source", "spent", "updated_at", "used"],
  );
  assert.equal(await reserveCall("company-data/fake", null), true);
  const app = asRole("app");
  const [row] = await app.sourceUsage.findMany();
  assert.equal(row?.used, 1);
  assert.equal(await sqlstate(app.$executeRaw`DELETE FROM source_usage`), "42501");
  assert.equal(await sqlstate(app.$executeRaw`UPDATE source_usage SET used = -1`), "23514");
  assert.equal(await app.sourceUsage.count(), 1);
});

test("every public command and query of enrichment goes through the tenant client of the caller's run", async () => {
  const id = "per_00000000000000000000000000";
  await assertScoped(() => requestEnrichment({ personId: id, requestKey: "k" }));
  await assertScoped(() => lastRunOf(id));
  await assertScoped(() => sourcesTried("erun_00000000000000000000000000"));
  await assertScoped(() => erasePerson(id));
  await assertScoped(() => createRun({ personId: id, trigger: "request", requestKey: "k" }));
  await assertScoped(() => requestLookup({ personId: id, requestKey: "k" }));
  await assertScoped(() => requestReverification({ personId: id, requestKey: "k" }));
  await assertScoped(() => workEmailOf(id));
  await assertScoped(() => addressOf("cp_00000000000000000000000000"));
  await assertScoped(() => markBounced("cp_00000000000000000000000000", { at: AT }));
  await assertScoped(() => keepPhone(id, { number: "+48221234567", page: "https://a.example/" }));
  await assertScoped(() => leadPhones(id));
});

test("a phone (gamma-wr-100) is its workspace's: another workspace's lead page does not read it, its person is not found there, and the same number is kept there for its own person", async () => {
  const [a, b] = ["wsp_phone_a", "wsp_phone_b"];
  const [first, second] = [await personIn(a, "phone-a"), await personIn(b, "phone-b")];
  const page = "https://acme.example/team";
  const number = "+48 22 123 45 67";
  assert.equal((await run(a, () => keepPhone(first, { number, page }))).outcome, "kept");
  assert.equal((await run(b, () => keepPhone(second, { number, page }))).outcome, "kept");
  assert.equal((await run(a, () => leadPhones(first))).phones.length, 1);
  await assert.rejects(
    run(b, () => leadPhones(first)),
    (error) => isAppError(error) && error.code === "enrichment_person_not_found",
  );
  assert.equal(await asRole("app").contactPoint.count({ where: { value: "+48221234567" } }), 2);
});
