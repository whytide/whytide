// contacts' lead commands end to end (alpha-p5-020) on the worktree's database, in this file's
// schema, each inside a tenant run as its callers make one, with the audience a decision was judged
// against (gamma-p5-055), and a lead whose person has no LinkedIn profile, its CSV row too
// (gamma-rf-050). The routes' test is the api host's,
// core/apps/api/tests/contacts-leads.test.ts: a module never imports a host.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createLeadsForPersons } from "../domain/batch.ts";
import { PENDING_SNAPSHOTS_MAX, PENDING_SOURCES_MAX } from "../domain/constants.ts";
import { leadsCsv } from "../domain/export/leads-csv.ts";
import { firstSignalSource } from "../domain/lead.ts";
import {
  applyQualification,
  createLeadForPerson,
  getLead,
  type Lead,
  leadsPendingQualification,
  listLeads,
} from "../domain/leads.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import { useEnrichmentHold, useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
// A new lead is selectable at once here; enrichment-hold.test.ts holds it.
useEnrichmentHold(0);
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

/** A person's lead, decided `qualified` with `decision`'s audience and version, else pending. */
const leadOf = async (slug: string, decision?: { icpId?: string; icpVersion?: number }) => {
  const id = await personId(slug);
  await run(async () => {
    await createLeadForPerson({ personId: id, source: { kind: "signal", ref: slug } });
    if (decision) await applyQualification({ personId: id, status: "qualified", ...decision });
  });
  return id;
};
/** The person ids leadsPendingQualification answers, sorted: the test above proves their order. */
const waiting = (input: Parameters<typeof leadsPendingQualification>[0]) =>
  run(async () => (await leadsPendingQualification(input)).map((lead) => lead.personId).sort());
const sorted = (...ids: string[]) => ids.sort();
const refused = (field: string) => ({
  code: "contacts_input_invalid",
  details: { fields: [field] },
});

test("applyQualification with icpId stores the audience beside its version and getLead answers it; a decision without icpId stores null", async () => {
  const id = await leadOf("noor-audience");
  const scored = async () => {
    const { icpIdScored, icpVersionScored } = await asRole("app").lead.findFirstOrThrow();
    return { icpIdScored, icpVersionScored };
  };
  const decision = { personId: id, status: "qualified", fitScore: 71 } as const;
  const lead = await run(() => applyQualification({ ...decision, icpId: "icp_a", icpVersion: 2 }));
  const audienceA = { icpIdScored: "icp_a", icpVersionScored: 2 };
  assert.deepEqual(
    { icpIdScored: lead.icpIdScored, icpVersionScored: lead.icpVersionScored },
    audienceA,
  );
  assert.deepEqual(await scored(), audienceA);
  const read = await run(() => getLead(id));
  assert.deepEqual(
    { icpIdScored: read.icpIdScored, icpVersionScored: read.icpVersionScored },
    audienceA,
  );

  await run(() => applyQualification({ ...decision, icpVersion: 3 }));
  assert.deepEqual(await scored(), { icpIdScored: null, icpVersionScored: 3 });
  await assert.rejects(
    run(() => applyQualification({ ...decision, icpId: "", icpVersion: 4 })),
    refused("icpId"),
  );
  assert.deepEqual(await scored(), { icpIdScored: null, icpVersionScored: 3 });
});

test("leadsPendingQualification with an audience at its version answers the pending leads and that audience's leads decided below the version, never another's; without icpId, every lead below the version as before", async () => {
  const pending = await leadOf("aud-pending");
  const a2 = await leadOf("aud-a2", { icpId: "icp_a", icpVersion: 2 });
  await leadOf("aud-a3", { icpId: "icp_a", icpVersion: 3 });
  const b2 = await leadOf("aud-b2", { icpId: "icp_b", icpVersion: 2 });
  await leadOf("aud-b5", { icpId: "icp_b", icpVersion: 5 });
  const beforeAudiences = await leadOf("aud-before", { icpVersion: 1 });

  assert.deepEqual(
    await waiting({ limit: 10, icpId: "icp_a", icpVersion: 3 }),
    sorted(pending, a2),
  );
  assert.deepEqual(
    await waiting({ limit: 10, icpId: "icp_b", icpVersion: 5 }),
    sorted(pending, b2),
  );
  assert.deepEqual(
    await waiting({ limit: 10, icpVersion: 3 }),
    sorted(pending, a2, b2, beforeAudiences),
  );
  assert.deepEqual(await waiting({ limit: 10 }), [pending]);
});

test("leadsPendingQualification with isDefault also answers the leads decided before audiences (no icpId) below the version; isDefault needs icpId, and icpId needs its version", async () => {
  const pending = await leadOf("def-pending");
  const beforeAudiences = await leadOf("def-before", { icpVersion: 1 });
  await leadOf("def-before-current", { icpVersion: 2 });
  const defaultAtOne = await leadOf("def-one", { icpId: "icp_default", icpVersion: 1 });
  await leadOf("def-other", { icpId: "icp_other", icpVersion: 1 });

  const defaultAtTwo = { limit: 10, icpId: "icp_default", icpVersion: 2 };
  assert.deepEqual(
    await waiting({ ...defaultAtTwo, isDefault: true }),
    sorted(pending, beforeAudiences, defaultAtOne),
  );
  assert.deepEqual(await waiting(defaultAtTwo), sorted(pending, defaultAtOne));
  await assert.rejects(waiting({ limit: 10, icpVersion: 2, isDefault: true }), refused("icpId"));
  await assert.rejects(waiting({ limit: 10, icpId: "icp_default" }), refused("icpVersion"));
});

test("leadsPendingQualification with hardFilterReasons and currentSnapshotIds (title-check-ai) also answers the leads hard_filtered for one of the reasons and those whose current snapshot is one of the ids, of the audience with icpId; each list a list of codes or ids within its limit", async () => {
  const pending = await leadOf("ret-pending");
  /** A lead decided at version 2: hard_filtered for `reason`, or not_qualified with `snapshotId`. */
  type Decision = { reason?: string; icpId?: string; snapshotId?: string };
  const decided = async (slug: string, decision: Decision) => {
    const id = await leadOf(slug);
    const status = decision.snapshotId === undefined ? "hard_filtered" : "not_qualified";
    await run(() => applyQualification({ personId: id, status, icpVersion: 2, ...decision }));
    return id;
  };
  const title = await decided("ret-title", { reason: "title_mismatch" });
  await decided("ret-country", { reason: "country_mismatch" });
  const titleOfB = await decided("ret-title-b", { reason: "title_mismatch", icpId: "icp_b" });
  const agency = await decided("ret-agency", { snapshotId: "ssn_agency" });
  await decided("ret-own", { snapshotId: "ssn_own" });

  const atTwo = { limit: 10, icpVersion: 2 };
  const retired = { hardFilterReasons: ["title_mismatch"], currentSnapshotIds: ["ssn_agency"] };
  assert.deepEqual(await waiting(atTwo), [pending]);
  assert.deepEqual(
    await waiting({ ...atTwo, ...retired }),
    sorted(pending, title, titleOfB, agency),
  );
  assert.deepEqual(
    await waiting({ limit: 10, hardFilterReasons: ["title_mismatch"] }),
    sorted(pending, title, titleOfB),
  );
  assert.deepEqual(
    await waiting({ ...atTwo, ...retired, icpId: "icp_b" }),
    sorted(pending, titleOfB),
  );
  const none = { hardFilterReasons: [], currentSnapshotIds: [] };
  assert.deepEqual(await waiting({ ...atTwo, ...none }), [pending]);
  await assert.rejects(
    waiting({ ...atTwo, hardFilterReasons: ["Title mismatch"] }),
    refused("hardFilterReasons.0"),
  );
  const many = Array.from({ length: PENDING_SNAPSHOTS_MAX + 1 }, (_, n) => `ssn_${n}`);
  await assert.rejects(
    waiting({ ...atTwo, currentSnapshotIds: many }),
    refused("currentSnapshotIds"),
  );
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

test("leadsPendingQualification with pendingSources and decidedSources takes the leads by their first signal source, as firstSignalSource reads it: one of `in`, or none or one outside `notIn`; each list within its limit (review-gaps-2)", async () => {
  /** A pending lead brought by `refs`, in their order. */
  const brought = async (slug: string, refs: [kind: "signal" | "imported", ref: string][]) => {
    const id = await personId(slug);
    for (const [kind, ref] of refs) {
      await run(() => createLeadForPerson({ personId: id, source: { kind, ref } }));
    }
    return id;
  };
  const a = await brought("src-a", [["signal", "src_a"]]);
  const importedThenB = await brought("src-ib", [
    ["imported", "src_a"],
    ["signal", "src_b"],
  ]);
  const bThenA = await brought("src-ba", [
    ["signal", "src_b"],
    ["signal", "src_a"],
  ]);
  const noSignal = await brought("src-none", [["imported", "imp_1"]]);
  const decidedA = await leadOf("src_a", { icpId: "icp_a", icpVersion: 1 });
  const firsts = await run(async () =>
    (await leadsPendingQualification({ limit: 10 })).map((lead) => firstSignalSource(lead.sources)),
  );
  assert.deepEqual(firsts, ["src_a", "src_b", "src_b", undefined]);

  assert.deepEqual(await waiting({ limit: 10, pendingSources: { in: ["src_a"] } }), [a]);
  assert.deepEqual(
    await waiting({ limit: 10, pendingSources: { in: ["src_b"] } }),
    sorted(importedThenB, bThenA),
  );
  assert.deepEqual(
    await waiting({ limit: 10, pendingSources: { notIn: ["src_b"] } }),
    sorted(a, noSignal),
  );
  assert.deepEqual(await waiting({ limit: 10, pendingSources: { in: [] } }), []);
  assert.deepEqual(
    await waiting({ limit: 10, pendingSources: { notIn: [] } }),
    sorted(a, importedThenB, bThenA, noSignal),
  );
  const decided = { limit: 10, icpId: "icp_a", icpVersion: 2, pendingSources: { in: [] } };
  assert.deepEqual(await waiting({ ...decided, decidedSources: { in: ["src_a"] } }), [decidedA]);
  assert.deepEqual(await waiting({ ...decided, decidedSources: { notIn: ["src_a"] } }), []);
  const many = Array.from({ length: PENDING_SOURCES_MAX + 1 }, (_, n) => `src_${n}`);
  await assert.rejects(
    waiting({ limit: 10, pendingSources: { in: many } }),
    refused("pendingSources"),
  );
});

test("a lead whose person has no LinkedIn profile (gamma-rf-050): read and listed with a null URL, and its CSV row's linkedin_url cell is empty, with no address", async () => {
  const id = await run(async () => {
    const profile = { email: "noor.no-profile@harbor.example", firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
  assert.equal((await run(() => getLead(id))).person.linkedinUrl, null);
  const { leads } = await run(() => listLeads({ sort: "newest", limit: 10 }));
  assert.deepEqual(
    leads.map(({ person }) => person.linkedinUrl),
    [null],
  );
  let text = "";
  for await (const chunk of leadsCsv({}, run)) text += chunk;
  const [header = "", row = ""] = text.replace(/^﻿/, "").split("\r\n");
  assert.equal(header.split(",").at(-1), "linkedin_url");
  assert.ok(row.startsWith("Noor,") && row.endsWith(","), row);
  assert.ok(!text.includes("no-profile"), "no address leaves");
});
