// Enrichment's hold (gamma-en-040; README.md "Enrichment's hold") on the worktree's database, in this
// file's schema, inside tenant runs as its callers make them: each command that creates a lead holds
// it for the setting's minutes in the same write, and a lead that exists keeps its hold; the
// selection leaves a held pending lead out until its hold ends, is released or the lead is judged;
// the reader answers the run's workspace's held leads, oldest first. The clock is moved by moving the
// stored times back. Two workspaces for the reader: tests/tenancy.test.ts.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createLeadsForPersons } from "../domain/batch.ts";
import { leadsHeldForEnrichment, releaseEnrichmentHold } from "../domain/hold.ts";
import { createLeadByMember } from "../domain/lead-create.ts";
import {
  applyQualification,
  createLeadForPerson,
  getLead,
  leadsPendingQualification,
} from "../domain/leads.ts";
import { upsertPersonFromSource } from "../domain/persons.ts";
import { useEnrichmentHold, useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
afterEach(() => useEnrichmentHold(undefined));
const WS = "wsp_hold_test";
const OTHER = "wsp_hold_other";
const MINUTE = 60_000;
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>, workspaceId = WS) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const source = { kind: "imported", ref: "imp_1" } as const;

/** A person of the workspace, as an import writes one. */
const person = (slug: string, workspaceId = WS) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    return (await upsertPersonFromSource({ source: "import", provider: "csv", profile })).person.id;
  }, workspaceId);
/** A person and their new lead from an import. */
const lead = async (slug: string, workspaceId = WS) => {
  const personId = await person(slug, workspaceId);
  await run(() => createLeadForPerson({ personId, source }), workspaceId);
  return personId;
};
/** The person ids the batch's read selects now. */
const pending = async () =>
  (await run(() => leadsPendingQualification({ limit: 10 }))).map(({ personId }) => personId);
/** The lead's hold, `minutes` earlier: as if that much time went by. */
const pass = (personId: string, minutes: number) =>
  run(async () => {
    await tenantClient.$executeRaw`UPDATE leads
      SET enrichment_hold_until = enrichment_hold_until - ${minutes}::int * interval '1 minute'
      WHERE person_id = ${personId}`;
  });
/** The lead's creation, `minutes` ago: the reader's order. */
const createdAgo = (personId: string, minutes: number) =>
  run(async () => {
    await tenantClient.$executeRaw`UPDATE leads
      SET created_at = now() - ${minutes}::int * interval '1 minute' WHERE person_id = ${personId}`;
  });

test("createLeadForPerson, createLeadsForPersons and createLeadByMember hold a new lead for the setting's 60 minutes from its creation, in the creating write; a lead that exists keeps its hold when another source comes", async () => {
  useEnrichmentHold(60);
  const [one, many] = [await person("hold-one"), await person("hold-many")];
  const from = Date.now();
  const created = (await run(() => createLeadForPerson({ personId: one, source }))).lead;
  const [batched] = await run(() => createLeadsForPersons([{ personId: many, source }]));
  const url = "https://linkedin.com/in/hold-member";
  const byMember = await run(() => createLeadByMember({ linkedinUrl: url, firstName: "Dana" }));
  const to = Date.now();
  const holds = [created, batched?.lead, await run(() => getLead(byMember))];
  for (const [index, held] of holds.entries()) {
    const at = held?.enrichmentHoldUntil?.getTime() ?? 0;
    assert.ok(at >= from + 60 * MINUTE && at <= to + 60 * MINUTE, `lead ${index}: ${at}`);
  }

  useEnrichmentHold(0);
  const signal = { kind: "signal", ref: "sig_1" } as const;
  const again = await run(() => createLeadForPerson({ personId: one, source: signal }));
  assert.deepEqual(again.lead.enrichmentHoldUntil, created.enrichmentHoldUntil);
  const [later] = await run(() => createLeadsForPersons([{ personId: many, source: signal }]));
  assert.equal(later?.created, false);
  assert.deepEqual(later?.lead.enrichmentHoldUntil, batched?.lead.enrichmentHoldUntil);
});

test("with the setting at 60, a new lead is left out of leadsPendingQualification for 60 minutes, then selected; with the setting at 0, it has no hold and is selected at once", async () => {
  useEnrichmentHold(60);
  const held = await lead("held");
  assert.deepEqual(await pending(), []);
  await pass(held, 59);
  assert.deepEqual(await pending(), [], "a minute to go");
  await pass(held, 1);
  assert.deepEqual(await pending(), [held]);

  useEnrichmentHold(0);
  const free = await lead("free");
  assert.equal((await run(() => getLead(free))).enrichmentHoldUntil, null);
  assert.deepEqual(await pending(), [held, free]);
});

test("releaseEnrichmentHold makes a held lead selectable at once, keeps updated_at and answers the count; a second release is a no-op; another workspace's lead and an unknown id are left as they are", async () => {
  useEnrichmentHold(60);
  const ours = await lead("released");
  const theirs = await lead("theirs", OTHER);
  const { updatedAt } = await run(() => getLead(ours));
  const unknown = "per_00000000000000000000000000";
  assert.equal(await run(() => releaseEnrichmentHold([ours, theirs, unknown])), 1);
  assert.deepEqual(await pending(), [ours]);
  const released = await run(() => getLead(ours));
  assert.equal(released.enrichmentHoldUntil, null);
  assert.deepEqual(released.updatedAt, updatedAt, "the list's time of qualification stays");
  assert.equal(await run(() => releaseEnrichmentHold([ours])), 0);
  assert.equal(await run(() => releaseEnrichmentHold([])), 0);
  assert.notEqual((await run(() => getLead(theirs), OTHER)).enrichmentHoldUntil, null);
});

test("only a first judgement waits: applyQualification ends the hold, so a lead put back to pending, as a member's new assessment puts one, is selected at once; a decided lead of an older ICP version is selected whatever its hold", async () => {
  useEnrichmentHold(60);
  const judged = await lead("judged");
  await run(() => applyQualification({ personId: judged, status: "qualified", icpVersion: 1 }));
  assert.equal((await run(() => getLead(judged))).enrichmentHoldUntil, null);
  const again = { personId: judged, status: "pending", reason: "member_requested" } as const;
  await run(() => applyQualification(again));
  assert.deepEqual(await pending(), [judged]);

  const older = await lead("older");
  await run(() => applyQualification({ personId: older, status: "qualified", icpVersion: 1 }));
  await run(async () => {
    await tenantClient.$executeRaw`UPDATE leads SET enrichment_hold_until = now() + interval '1 hour'
      WHERE person_id = ${older}`;
  });
  const read = await run(() => leadsPendingQualification({ limit: 10, icpVersion: 2 }));
  assert.deepEqual(read.map(({ personId }) => personId).sort(), [judged, older].sort());
});

test("leadsHeldForEnrichment answers the person ids of the leads held past now, oldest first, at most `limit`; a hold that ended or was released is none", async () => {
  useEnrichmentHold(60);
  const ids: string[] = [];
  for (const slug of ["held-a", "held-b", "held-c", "held-d"]) ids.push(await lead(slug));
  const [a, b, c, d] = ids as [string, string, string, string];
  // Created d, b, a, c: the reader's order, whatever the ids' own.
  for (const [personId, minutes] of [
    [d, 4],
    [b, 3],
    [a, 2],
    [c, 1],
  ] as const) {
    await createdAgo(personId, minutes);
  }
  assert.deepEqual(await run(() => leadsHeldForEnrichment({ limit: 10 })), [d, b, a, c]);
  assert.deepEqual(await run(() => leadsHeldForEnrichment({ limit: 2 })), [d, b]);
  await pass(d, 60);
  await run(() => releaseEnrichmentHold([a]));
  assert.deepEqual(await run(() => leadsHeldForEnrichment({ limit: 10 })), [b, c]);
});

test("leadsHeldForEnrichment takes a limit from 1 to 100 and releaseEnrichmentHold 100 ids at most; anything else is contacts_input_invalid", async () => {
  for (const limit of [0, 101, 1.5]) {
    await assert.rejects(
      run(() => leadsHeldForEnrichment({ limit })),
      fails("contacts_input_invalid"),
    );
  }
  const ids = Array.from({ length: 101 }, (_, index) => `per_${index}`);
  await assert.rejects(
    run(() => releaseEnrichmentHold(ids)),
    fails("contacts_input_invalid"),
  );
  await assert.rejects(
    run(() => releaseEnrichmentHold([""])),
    fails("contacts_input_invalid"),
  );
  assert.equal(await run(() => releaseEnrichmentHold(ids.slice(0, 100))), 0);
});
