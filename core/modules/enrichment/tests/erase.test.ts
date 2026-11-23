// The person's erasure (core/modules/privacy README "Erasers"; domain/erase.ts): every run of the
// person deleted, with their contact points, lookups and cache entries (gamma-en-080), counted by
// table, and no one else's; a second erasure deletes none; the counters, which hold no person,
// stay. A run erased under way finds no row: its steps do nothing and fail
// none. Privacy's registration of the eraser is privacy's tests.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { erasePerson } from "../domain/erase.ts";
import { requestLookup } from "../domain/lookup/request.ts";
import { lastRunOf } from "../domain/readers.ts";
import { finishRun, prepareRun, recordTried } from "../domain/runs.ts";
import { loadSources } from "../domain/sources/index.ts";
import { askSource } from "../domain/step.ts";
import { reserveCall } from "../domain/usage.ts";
import {
  createCacheEntry,
  createContactPoint,
  createRun,
  useEnrichmentClient,
  useSourceLists,
} from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const WS = "wsp_erase_test";
const principal = servicePrincipal("enrichment_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: asRole("app") });
afterEach(() => useSourceLists(undefined));
const AT = new Date("2026-11-13T10:00:00Z");
const used = async () => (await asRole("app").sourceUsage.findMany()).map((row) => row.used);
/** A person of the workspace with a run per key. */
const personWithRuns = (slug: string, keys: string[]) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    for (const requestKey of keys) {
      await createRun({ personId: person.id, trigger: "request", requestKey });
    }
    return person.id;
  });

test("erasePerson deletes the person's runs and answers their count; another person's stay; again, it deletes none; the counters stay", async () => {
  const erased = await personWithRuns("erase-me", ["new_lead:1", "request:2"]);
  const kept = await personWithRuns("keep-me", ["request:3"]);
  assert.equal(await reserveCall("company-data/fake", null), true);
  for (const [personId, slug] of [
    [erased, "erase-me"],
    [kept, "keep-me"],
  ] as const) {
    await run(async () => {
      const stamp = { kind: "work_email", sourceClass: "email_finder", provider: "fake" } as const;
      await createContactPoint(personId, {
        ...stamp,
        address: `${slug}@example.com`,
        verifiedAt: AT,
      });
      await requestLookup({ personId, requestKey: `lookup:${slug}` });
      const key = { personId, keyHash: slug.padEnd(64, "0"), provider: "fake", at: AT };
      await createCacheEntry({ ...key, kind: "email", address: `${slug}@example.com` });
    });
  }
  const none = { contact_points: 0, enrichment_requests: 0, enrichment_cache_entries: 0 };
  assert.deepEqual(await run(() => erasePerson(erased)), {
    enrichment_runs: 2,
    contact_points: 1,
    enrichment_requests: 1,
    enrichment_cache_entries: 1,
  });
  assert.equal(await run(() => lastRunOf(erased)), null);
  assert.notEqual(await run(() => lastRunOf(kept)), null);
  const app = asRole("app");
  for (const table of [
    app.contactPoint,
    app.enrichmentRequest,
    app.enrichmentCacheEntry,
  ] as const) {
    const left = await (table as typeof app.contactPoint).findMany({ select: { personId: true } });
    assert.deepEqual(left, [{ personId: kept }]);
  }
  assert.deepEqual(await run(() => erasePerson(erased)), { enrichment_runs: 0, ...none });
  assert.equal(await asRole("app").sourceUsage.count(), 1);
  await assert.rejects(
    run(() => erasePerson("")),
    { code: "enrichment_input_invalid" },
  );
});

test("a run erased under way finds no row: the prepare plans nothing, a source asks nothing and counts no call, the outcome and the finish write nothing, and none fails", async () => {
  useSourceLists({ company: ["company-data"], person: [], companyData: ["fake"] });
  const personId = await personWithRuns("erased-under-way", ["request:4"]);
  const last = await run(() => lastRunOf(personId));
  const runId = last?.runId ?? assert.fail("no run");
  await run(() => erasePerson(personId));
  const { sources } = await loadSources();
  assert.equal(sources.length, 1);
  const plan = await run(() => prepareRun(runId, sources));
  assert.deepEqual(plan, { sources: [], wanted: [], have: [] });
  const before = await used();
  const step = await askSource({ tenant: run }, { runId, source: "company-data/fake" });
  assert.deepEqual(step, { outcome: "not_found", filled: [], inputsAdded: false });
  assert.deepEqual(await used(), before);
  const entry = { source: "company-data/fake", outcome: "failed" as const, filled: [], ms: 0 };
  await run(() => recordTried(runId, { ...entry, code: "activity_timeout" }));
  assert.deepEqual(await run(() => finishRun(runId, true)), { filled: [] });
  assert.equal(await run(() => lastRunOf(personId)), null);
});
