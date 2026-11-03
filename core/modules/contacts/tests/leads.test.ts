// contacts' lead commands end to end (alpha-p5-020) on the worktree's database, in this file's
// schema, each inside a tenant run as its callers make one. The routes' test is the api host's,
// core/apps/api/tests/contacts-leads.test.ts: a module never imports a host.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createLeadsForPersons } from "../domain/batch.ts";
import {
  applyQualification,
  createLeadForPerson,
  getLead,
  type Lead,
  leadsPendingQualification,
} from "../domain/leads.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: "wsp_leads_test", principal }, fn, { client: asRole("app") });
const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const nobody = "per_00000000000000000000000000";
/** A person of the workspace, as an import writes one. */
const personId = (slug: string) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    return (await upsertPersonFromSource({ source: "import", provider: "csv", profile })).person.id;
  });
/** What qualification wrote on the lead, as the command answers it or the row holds it. */
const decision = (lead: Omit<Lead, "sources" | "why"> & { why: unknown }) => ({
  status: lead.qualificationStatus,
  fitScore: lead.fitScore,
  confidence: lead.fitConfidence,
  tier: lead.tier,
  why: lead.why,
  snapshotId: lead.currentScoreSnapshotId,
  icpVersion: lead.icpVersionScored,
  hardFilterReason: lead.hardFilterReason,
  statusReason: lead.statusReason,
});

test("createLeadForPerson from an import then a signal: one lead, labeled imported, with two sources and the import's time as first_source_at", async () => {
  const id = await personId("noor-1");
  const importedAt = new Date("2026-10-01T08:00:00Z");
  const signalAt = new Date("2026-10-05T08:00:00Z");
  const imported = { kind: "imported", ref: "imp_1", at: importedAt } as const;
  const signal = { kind: "signal", ref: "sig_1", at: signalAt } as const;
  const first = await run(() => createLeadForPerson({ personId: id, source: imported }));
  const second = await run(() => createLeadForPerson({ personId: id, source: signal }));
  const again = await run(() => createLeadForPerson({ personId: id, source: signal }));
  assert.deepEqual([first.created, second.created, again.created], [true, false, false]);

  const leads = await asRole("app").lead.findMany();
  assert.deepEqual(
    leads.map((lead) => [lead.personId, lead.sourceLabel, lead.qualificationStatus]),
    [[id, "imported", "pending"]],
  );
  assert.deepEqual(leads[0]?.sources, [
    { kind: "imported", ref: "imp_1", at: importedAt.toISOString() },
    { kind: "signal", ref: "sig_1", at: signalAt.toISOString() },
  ]);
  assert.deepEqual(leads[0]?.firstSourceAt, importedAt);
  await assert.rejects(
    run(() => createLeadForPerson({ personId: nobody, source: signal })),
    fails("person_not_found"),
  );
});

test("a signal source's label, trimmed, and its URL are stored with the lead's source; the same source again with a new label renames its entry, keeps its time and URL, and adds none", async () => {
  const id = await personId("noor-named");
  const url = "https://posts.example/launch";
  const signal = { kind: "signal", ref: "src_1", url } as const;
  const at = new Date("2026-10-01T08:00:00Z");
  await run(() =>
    createLeadForPerson({ personId: id, source: { ...signal, at, label: "  Launch post " } }),
  );
  const stored = async () => (await asRole("app").lead.findFirstOrThrow()).sources;
  const entry = { kind: "signal", ref: "src_1", at: at.toISOString(), url };
  assert.deepEqual(await stored(), [{ ...entry, label: "Launch post" }]);

  const later = new Date("2026-10-04T08:00:00Z");
  const renamed = {
    kind: "signal",
    ref: "src_1",
    at: later,
    label: "Launch post, week 2",
  } as const;
  const { lead } = await run(() => createLeadForPerson({ personId: id, source: renamed }));
  assert.deepEqual(lead.sources, [{ ...entry, label: "Launch post, week 2" }]);
  assert.deepEqual(await stored(), lead.sources);
});

test("a source URL that is not https or does not parse, or a label over 200 characters, is contacts_input_invalid naming it, from both commands, and nothing is written", async () => {
  const id = await personId("noor-refused");
  const signal = { kind: "signal", ref: "src_2" } as const;
  const refused = [
    [{ ...signal, url: "http://posts.example/launch" }, "source.url"],
    [{ ...signal, url: "https://" }, "source.url"],
    [{ ...signal, label: "x".repeat(201) }, "source.label"],
  ] as const;
  for (const [source, field] of refused) {
    const named = { code: "contacts_input_invalid", details: { fields: [field] } };
    await assert.rejects(
      run(() => createLeadForPerson({ personId: id, source })),
      named,
    );
    await assert.rejects(
      run(() => createLeadsForPersons([{ personId: id, source }])),
      named,
    );
  }
  assert.equal(await asRole("app").lead.count(), 0);
});

test("applyQualification sets the status, score, tier, confidence and why in one update; a status outside the list is rejected and changes nothing", async () => {
  const id = await personId("noor-2");
  await run(() => createLeadForPerson({ personId: id, source: { kind: "signal", ref: "sig_2" } }));
  const pending = await run(() => leadsPendingQualification({ limit: 10 }));
  assert.deepEqual(
    pending.map((lead) => lead.personId),
    [id],
  );

  const why = [{ key: "qualification.why.fit", params: { title: "Head of Data", points: 3 } }];
  const qualified = {
    personId: id,
    status: "qualified",
    fitScore: 82,
    confidence: "high",
    tier: "hot",
    why,
    snapshotId: "snap_1",
    icpVersion: 3,
  } as const;
  const lead = await run(() => applyQualification(qualified));
  const expected = { ...qualified, hardFilterReason: null, statusReason: null };
  const { personId: _id, ...written } = expected;
  assert.deepEqual(decision(lead), written);
  const stored = await asRole("app").lead.findFirstOrThrow();
  assert.deepEqual(decision(stored), written);
  assert.deepEqual(await run(() => leadsPendingQualification({ limit: 10 })), []);

  const approved = { ...qualified, status: "approved" } as unknown as typeof qualified;
  await assert.rejects(
    run(() => applyQualification(approved)),
    fails("contacts_input_invalid"),
  );
  assert.deepEqual(decision(await asRole("app").lead.findFirstOrThrow()), written);

  const filtered = await run(() =>
    applyQualification({ personId: id, status: "hard_filtered", reason: "title_mismatch" }),
  );
  assert.deepEqual(decision(filtered), {
    status: "hard_filtered",
    fitScore: null,
    confidence: null,
    tier: null,
    why: [],
    snapshotId: null,
    icpVersion: null,
    hardFilterReason: "title_mismatch",
    statusReason: null,
  });
  await assert.rejects(
    run(() => applyQualification({ ...qualified, personId: nobody })),
    fails("lead_not_found"),
  );
});

test("leadsPendingQualification with the ICP's version adds the leads decided at an older one, oldest first, up to the limit", async () => {
  const ids: string[] = [];
  for (const slug of ["old-a", "old-b", "old-c", "old-d", "old-e"]) {
    const id = await personId(slug);
    await run(() => createLeadForPerson({ personId: id, source: { kind: "signal", ref: slug } }));
    ids.push(id);
  }
  const [pending, scoredAtOne, filteredAtTwo, failedAtOne, noVersion] = ids as [
    string,
    string,
    string,
    string,
    string,
  ];
  await run(async () => {
    await applyQualification({ personId: scoredAtOne, status: "qualified", icpVersion: 1 });
    await applyQualification({ personId: filteredAtTwo, status: "hard_filtered", icpVersion: 2 });
    await applyQualification({ personId: failedAtOne, status: "ai_failed", icpVersion: 1 });
    await applyQualification({ personId: noVersion, status: "qualified" });
  });
  const select = (input: { limit: number; icpVersion?: number }) =>
    run(async () => (await leadsPendingQualification(input)).map((lead) => lead.personId));
  assert.deepEqual(await select({ limit: 10, icpVersion: 2 }), [pending, scoredAtOne, failedAtOne]);
  assert.deepEqual(await select({ limit: 2, icpVersion: 2 }), [pending, scoredAtOne]);
  assert.deepEqual(await select({ limit: 10 }), [pending]);
  await assert.rejects(select({ limit: 10, icpVersion: 0 }), fails("contacts_input_invalid"));
});

test("erasePerson removes the lead with the person", async () => {
  const id = await personId("noor-3");
  await run(() =>
    createLeadForPerson({ personId: id, source: { kind: "imported", ref: "imp_3" } }),
  );
  await run(() => erasePerson(id));
  const app = asRole("app");
  assert.deepEqual([await app.lead.count(), await app.person.count()], [0, 0]);
  await assert.rejects(
    run(() => getLead(id)),
    fails("lead_not_found"),
  );
});
