// test:tenancy for contacts' ten tables (docs/rules/security.md §3; core/packages/db README
// "Register a tenant table in the isolation test"): the same person, company, hash, lead (with its
// source's label), review decision, never-contact entry, status change, exclusion list, list's
// domain and address hash (gamma-rf-040) in workspaces A and B are two rows, each read by the
// module's scoped query in its own workspace only, as is a lead held for enrichment by enrichment's
// reader (gamma-en-040); an entry or an exclusion list in A, on any channel or as a relationship,
// suppresses no one in B; app holds no DELETE on the never-contact entries, the exclusion lists or
// their domains, and no UPDATE on the domains; the database refuses a link across workspaces; and
// every public command and query goes through the tenant client of the caller's run. The company
// index (gamma-rf-010) across organizations, on tenancy's workspaces: a shared class's fact is read
// by every organization, any other by its own only, none with the setting empty; a key one
// workspace found reaches its organization's others at their refresh, and their blocks then match;
// app holds no DELETE on companies or group_companies. An address entry in A stops no one in B who
// holds the same address, and app holds no UPDATE on person_email_hashes.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, sqlstate, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createWorkspace } from "@whytide/tenancy";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { createLeadsForPersons, upsertPersonsFromSource } from "../domain/batch.ts";
import {
  getCompany,
  linkPersonToCompany,
  refreshCompany,
  upsertCompany,
} from "../domain/companies.ts";
import { recordPersonEmail } from "../domain/emails.ts";
import {
  importExclusionList,
  listExclusionLists,
  removeExclusionList,
} from "../domain/exclusions/lists.ts";
import { isHashed, purgeExpiredHashes, recordHash } from "../domain/hashes.ts";
import { leadsHeldForEnrichment, releaseEnrichmentHold } from "../domain/hold.ts";
import { createLeadByMember } from "../domain/lead-create.ts";
import {
  applyQualification,
  createLeadForPerson,
  getLead,
  leadNeighbours,
  leadsPendingQualification,
  listLeads,
} from "../domain/leads.ts";
import { approveLead, listStatusChanges, recordLeadStatus } from "../domain/outreach/status.ts";
import { recordPersonCountry } from "../domain/person-country.ts";
import { editLeadPerson } from "../domain/person-edit.ts";
import {
  erasePerson,
  findPersonByLinkedinUrl,
  getPerson,
  listPersons,
  upsertPersonFromSource,
} from "../domain/persons.ts";
import { latestReviews, listReviews, reviewLead, reviewSummary } from "../domain/review/reviews.ts";
import {
  lastTouchAt,
  recordTouch,
  suppressedAt,
  suppressionOf,
  suppressionsOf,
} from "../domain/suppression/checks.ts";
import {
  addOptOut,
  addSuppression,
  listSuppression,
  removeSuppression,
} from "../domain/suppression/entries.ts";
import { useEnrichmentHold, useHashSalt, useSharedFactSources } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
// Every new lead is held, so that enrichment's reader has one to read in each workspace.
useEnrichmentHold(60);
const principal = servicePrincipal("contacts_test");
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const linkedinUrl = "https://linkedin.com/in/dana-sample";
const person = {
  source: "import",
  provider: "csv",
  profile: { linkedinUrl, firstName: "Dana" },
} as const;
const company = {
  source: "import",
  provider: "csv",
  company: { name: "Blue Harbor Labs", domain: "blueharbor.example" },
} as const;
const source = { kind: "imported", ref: "imp_1" } as const;
const notAFit = { decision: "not_a_fit", reasonCode: "bad_timing" } as const;
/** An exclusion list of the company's domain, as the reader answers a one-row file. */
const exclusions = {
  name: "customers.csv",
  relationship: "customer",
  createdBy: "usr_tenancy",
  file: { domains: [{ row: 2, domain: "blueharbor.example" }], rejected: [] },
} as const;

isolationTest("persons", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => (await upsertPersonFromSource(person)).person),
  readAs: (workspaceId) =>
    run(workspaceId, async () => (await listPersons({ limit: 100 })).persons),
});

isolationTest("workspace_companies", {
  createRow: (workspaceId) => run(workspaceId, async () => (await upsertCompany(company)).company),
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.workspaceCompany.findMany()),
});

isolationTest("person_hashes", {
  createRow: (workspaceId) =>
    run(workspaceId, async (tx) => {
      await recordHash({ linkedinUrl, kind: "erased" });
      return tx.personHash.findFirstOrThrow({ select: { id: true } });
    }),
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.personHash.findMany()),
});

// A lead and its source, named for its workspace: the list shows both in that workspace only.
isolationTest("leads", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      const label = `Launch post of ${workspaceId}`;
      const url = "https://posts.example/launch";
      const named = { kind: "signal", ref: "src_1", label, url } as const;
      const { lead } = await createLeadForPerson({ personId, source: named });
      return { id: `${lead.personId} ${label}` };
    }),
  readAs: (workspaceId) =>
    run(workspaceId, async () => {
      const { leads } = await listLeads({ sort: "newest", limit: 100 });
      return leads.flatMap(({ personId, sources }) =>
        sources.map(({ label }) => ({ id: `${personId} ${label}` })),
      );
    }),
});

// A held lead, as enrichment's reader answers it: its workspace's own only.
isolationTest("leads held for enrichment", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      await createLeadForPerson({ personId, source });
      return { id: personId };
    }),
  readAs: (workspaceId) =>
    run(workspaceId, async () =>
      (await leadsHeldForEnrichment({ limit: 100 })).map((id) => ({ id })),
    ),
});

isolationTest("review_decisions", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      await createLeadForPerson({ personId, source });
      return reviewLead({ personId, ...notAFit });
    }),
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.reviewDecision.findMany()),
});

isolationTest("lead_status_changes", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      await createLeadForPerson({ personId, source });
      const change = await recordLeadStatus(personId, "approved", { actor: { type: "system" } });
      return change ?? assert.fail("a new lead's first change writes a row");
    }),
  readAs: (workspaceId) => run(workspaceId, (tx) => tx.leadStatusChange.findMany()),
});

isolationTest("suppression_entries", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      return (await addSuppression({ kind: "person", personId, createdBy: "usr_tenancy" })).entry;
    }),
  readAs: (workspaceId) =>
    run(workspaceId, async () => (await listSuppression({ limit: 100 })).entries),
});

isolationTest("exclusion_lists", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => (await importExclusionList(exclusions)).list),
  readAs: (workspaceId) =>
    run(workspaceId, async () => (await listExclusionLists({ limit: 100 })).lists),
});

// A list's domains have no id of their own: each row is read as its list's.
isolationTest("exclusion_list_domains", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => ({ id: (await importExclusionList(exclusions)).list.id })),
  readAs: (workspaceId) =>
    run(workspaceId, async (tx) =>
      (await tx.exclusionListDomain.findMany()).map(({ exclusionListId: id }) => ({ id })),
    ),
});

// An address's hash has no id of its own: each row is read as its person's.
isolationTest("person_email_hashes", {
  createRow: (workspaceId) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      await recordPersonEmail({ personId, address: "dana@blueharbor.example" });
      return { id: personId };
    }),
  readAs: (workspaceId) =>
    run(workspaceId, async (tx) =>
      (await tx.personEmailHash.findMany()).map(({ personId: id }) => ({ id })),
    ),
});

/** The same person at the same company, in the workspace given; the person's id. */
const atCompany = async (workspaceId: string) =>
  run(workspaceId, async () => {
    const { id: personId } = (await upsertPersonFromSource(person)).person;
    const { id: companyId } = (await upsertCompany(company)).company;
    await linkPersonToCompany({ personId, companyId });
    return personId;
  });

test("an entry in one workspace suppresses no one in another: the same person and company in B stay allowed", async () => {
  const [ours, theirs] = [await atCompany("wsp_block_a"), await atCompany("wsp_block_b")];
  await run("wsp_block_a", async () => {
    await addSuppression({ kind: "company", value: "blueharbor.example", createdBy: "usr_a" });
    await addOptOut(ours, { source: "system", reason: "reply_opt_out" });
  });
  const answer = (workspaceId: string, personId: string) =>
    run(workspaceId, () => suppressionOf(personId, { newEnrollment: true }));
  assert.deepEqual(await answer("wsp_block_a", ours), { suppressed: true, reason: "opted_out" });
  assert.deepEqual(await answer("wsp_block_b", theirs), { suppressed: false });
  // A's person is no person of B's.
  const notFound = { suppressed: true, reason: "person_not_found" };
  assert.deepEqual(await answer("wsp_block_b", ours), notFound);
});

test("an address entry in A, or an opt-out on it, stops no one in B who holds the same address: B's person allowed, B's address recorded free; A's person stopped", async () => {
  const [ours, theirs] = [await atCompany("wsp_email_a"), await atCompany("wsp_email_b")];
  const address = "dana@blueharbor.example";
  const record = (workspaceId: string, personId: string) =>
    run(workspaceId, () => recordPersonEmail({ personId, address }));
  await record("wsp_email_a", ours);
  await run("wsp_email_a", async () => {
    await addSuppression({ kind: "person", value: address, createdBy: "usr_a" });
    const optOut = { kind: "person", value: address, layer: "opt_out" } as const;
    await addSuppression({ ...optOut, createdBy: "usr_a" });
  });
  assert.deepEqual(await record("wsp_email_b", theirs), { holder: "self", suppressed: false });
  const answer = (workspaceId: string, personId: string) =>
    run(workspaceId, () => suppressionOf(personId, { newEnrollment: true }));
  assert.deepEqual(await answer("wsp_email_a", ours), { suppressed: true, reason: "opted_out" });
  assert.deepEqual(await answer("wsp_email_b", theirs), { suppressed: false });
  const listed = await run("wsp_email_b", () => listSuppression({ limit: 100 }));
  assert.deepEqual(listed.entries, []);
});

test("app holds no UPDATE on person_email_hashes: an address's hash never moves to another person, 42501 by SQL or through the tenant client", async () => {
  const [ours, other] = await run("wsp_email_a", async () => {
    const one = (await upsertPersonFromSource(person)).person.id;
    const profile = { linkedinUrl: "https://linkedin.com/in/dana-other", firstName: "Dana" };
    const two = (await upsertPersonFromSource({ ...person, profile })).person.id;
    await recordPersonEmail({ personId: one, address: "dana@blueharbor.example" });
    return [one, two];
  });
  const app = asRole("app");
  const bySql = app.$executeRaw`UPDATE person_email_hashes SET person_id = ${other}`;
  assert.equal(await sqlstate(bySql), "42501", "insufficient_privilege");
  const byClient = run("wsp_email_a", (tx) =>
    tx.personEmailHash.updateMany({ where: { personId: ours }, data: { personId: other } }),
  );
  assert.equal(await sqlstate(byClient), "42501", "insufficient_privilege");
  const rows = await app.personEmailHash.findMany();
  assert.deepEqual(
    rows.map(({ personId }) => personId),
    [ours],
  );
});

test("an entry in A on one channel, on the other, or a competitor by domain, suppresses no one in B: every read, on every channel, and the batch", async () => {
  const [ours, theirs] = [await atCompany("wsp_channel_a"), await atCompany("wsp_channel_b")];
  await run("wsp_channel_a", async () => {
    for (const channel of ["linkedin", "email"] as const) {
      await addSuppression({ kind: "person", personId: ours, channel, createdBy: "usr_a" });
    }
    const competitor = {
      kind: "company",
      value: "blueharbor.example",
      relationship: "competitor",
    } as const;
    await addSuppression({ ...competitor, createdBy: "usr_a" });
  });
  const allowed = { suppressed: false };
  for (const channel of [undefined, "all", "linkedin", "email"] as const) {
    for (const newEnrollment of [true, false]) {
      const options = { newEnrollment, channel };
      const [one, batch] = await run("wsp_channel_b", async () => [
        await suppressionOf(theirs, options),
        [...(await suppressionsOf([theirs], options)).values()],
      ]);
      assert.deepEqual([one, batch], [allowed, [allowed]], JSON.stringify(options));
    }
    const at = await run("wsp_channel_b", () => suppressedAt(theirs, new Date(), { channel }));
    assert.deepEqual(at, allowed);
  }
  const ownRead = await run("wsp_channel_a", () =>
    suppressionOf(ours, { newEnrollment: false, channel: "email" }),
  );
  assert.deepEqual(ownRead, { suppressed: true, reason: "never_contact_company", channel: "all" });
});

test("app holds no DELETE on suppression_entries: a DELETE fails with 42501, by SQL or through the tenant client, and removing a block still works and keeps the row", async () => {
  const entry = await run("wsp_tenancy_a", async () => {
    const { id: personId } = (await upsertPersonFromSource(person)).person;
    return (await addSuppression({ kind: "person", personId, createdBy: "usr_a" })).entry;
  });
  const app = asRole("app");
  const bySql = app.$executeRaw`DELETE FROM suppression_entries WHERE id = ${entry.id}`;
  assert.equal(await sqlstate(bySql), "42501", "insufficient_privilege");
  const byClient = run("wsp_tenancy_a", (tx) =>
    tx.suppressionEntry.deleteMany({ where: { id: entry.id } }),
  );
  assert.equal(await sqlstate(byClient), "42501", "insufficient_privilege");
  await run("wsp_tenancy_a", () => removeSuppression(entry.id, { removedBy: "usr_a" }));
  const row = await app.suppressionEntry.findUniqueOrThrow({ where: { id: entry.id } });
  assert.deepEqual([row.removedBy, row.removedAt instanceof Date], ["usr_a", true]);
});

test("an exclusion list in A suppresses no one in B, which neither lists nor removes it; app holds no DELETE on exclusion_lists: 42501, by SQL or through the tenant client; nor DELETE or UPDATE on exclusion_list_domains", async () => {
  const [ours, theirs] = [await atCompany("wsp_list_a"), await atCompany("wsp_list_b")];
  const { list } = await run("wsp_list_a", () => importExclusionList(exclusions));
  const answer = (workspaceId: string, personId: string) =>
    run(workspaceId, () => suppressionOf(personId, { newEnrollment: true }));
  const company = { suppressed: true, reason: "never_contact_company" };
  assert.deepEqual(await answer("wsp_list_a", ours), company);
  assert.deepEqual(await answer("wsp_list_b", theirs), { suppressed: false });
  const listed = await run("wsp_list_b", () => listExclusionLists({ limit: 100 }));
  assert.deepEqual(listed.lists, []);
  const removal = run("wsp_list_b", () => removeExclusionList(list.id, { removedBy: "usr_b" }));
  await assert.rejects(removal, { code: "exclusion_list_not_found" });
  const app = asRole("app");
  const bySql = app.$executeRaw`DELETE FROM exclusion_lists WHERE id = ${list.id}`;
  assert.equal(await sqlstate(bySql), "42501", "insufficient_privilege");
  const byClient = run("wsp_list_a", (tx) =>
    tx.exclusionList.deleteMany({ where: { id: list.id } }),
  );
  assert.equal(await sqlstate(byClient), "42501", "insufficient_privilege");
  const kept = await app.exclusionList.findUniqueOrThrow({ where: { id: list.id } });
  assert.equal(kept.removedAt, null);
  // Its domains are written once (review-gaps): no DELETE and no UPDATE either.
  const domain = { exclusionListId: list.id };
  const dropped = app.$executeRaw`DELETE FROM exclusion_list_domains WHERE exclusion_list_id = ${list.id}`;
  assert.equal(await sqlstate(dropped), "42501", "insufficient_privilege");
  const changed = run("wsp_list_a", (tx) =>
    tx.exclusionListDomain.updateMany({ where: domain, data: { hash: "another" } }),
  );
  assert.equal(await sqlstate(changed), "42501", "insufficient_privilege");
  assert.equal(await app.exclusionListDomain.count({ where: domain }), 1);
});

test("the database refuses a lead, or a person's company, of another workspace: the keys are (workspace_id, id)", async () => {
  const theirs = await run("wsp_tenancy_a", async () => ({
    person: (await upsertPersonFromSource(person)).person,
    company: (await upsertCompany(company)).company,
  }));
  const ours = await run(
    "wsp_tenancy_b",
    async () => (await upsertPersonFromSource(person)).person,
  );
  const app = asRole("app");
  const lead = {
    personId: theirs.person.id,
    workspaceId: ours.workspaceId,
    sourceLabel: "imported",
    sources: [],
    firstSourceAt: new Date(),
  } as const;
  // Prisma answers a broken foreign key with P2003, naming the constraint.
  const refusedBy = (constraint: string) => (error: unknown) =>
    (error as { code?: unknown }).code === "P2003" && String(error).includes(constraint);
  await assert.rejects(
    app.lead.create({ data: lead }),
    refusedBy("leads_workspace_id_person_id_fkey"),
  );
  const link = app.person.update({
    where: { id: ours.id },
    data: { companyId: theirs.company.id },
  });
  await assert.rejects(link, refusedBy("persons_workspace_id_company_id_fkey"));
});

test("getCompany reads the run's company; another workspace's is company_not_found", async () => {
  const theirs = await run("wsp_company_a", async () => (await upsertCompany(company)).company);
  const read = await run("wsp_company_a", () => getCompany(theirs.id));
  assert.equal(read.name, "Blue Harbor Labs");
  const other = run("wsp_company_b", () => getCompany(theirs.id));
  await assert.rejects(other, { code: "company_not_found" });
});

test("every public command and query of contacts goes through the tenant client of the caller's run", async () => {
  const id = "per_00000000000000000000000000";
  await assertScoped(() => upsertPersonFromSource(person));
  await assertScoped(() => getPerson(id));
  await assertScoped(() => listPersons({ limit: 10 }));
  await assertScoped(() => erasePerson(id));
  await assertScoped(() => findPersonByLinkedinUrl(linkedinUrl));
  await assertScoped(() => upsertCompany(company));
  await assertScoped(() => getCompany("wco_0"));
  await assertScoped(() => refreshCompany("wco_0"));
  await assertScoped(() => linkPersonToCompany({ personId: id, companyId: "wco_0" }));
  await assertScoped(() => recordHash({ linkedinUrl, kind: "rejected_candidate" }));
  await assertScoped(() => isHashed({ linkedinUrls: [linkedinUrl] }));
  await assertScoped(() => isHashed({ providerIds: ["synthetic-member-1"] }));
  await assertScoped(() => purgeExpiredHashes());
  await assertScoped(() => upsertPersonsFromSource([person]));
  await assertScoped(() => createLeadForPerson({ personId: id, source }));
  await assertScoped(() => createLeadsForPersons([{ personId: id, source }]));
  await assertScoped(() => applyQualification({ personId: id, status: "pending" }));
  await assertScoped(() => listLeads({ sort: "fit", limit: 10 }));
  await assertScoped(() => getLead(id));
  await assertScoped(() => leadNeighbours({ personId: id, sort: "fit" }));
  await assertScoped(() => leadsPendingQualification({ limit: 10 }));
  const retired = { hardFilterReasons: ["title_mismatch"], currentSnapshotIds: ["ssn_0"] };
  await assertScoped(() => leadsPendingQualification({ limit: 10, icpVersion: 1, ...retired }));
  await assertScoped(() => leadsHeldForEnrichment({ limit: 10 }));
  await assertScoped(() => releaseEnrichmentHold([id]));
  const stamp = { source: "open_data", provider: "wikidata" } as const;
  await assertScoped(() => recordPersonCountry({ personId: id, country: "DE", stamp }));
  await assertScoped(() => reviewLead({ personId: id, ...notAFit }));
  await assertScoped(() => listReviews(id));
  await assertScoped(() => reviewSummary("2026-W40"));
  await assertScoped(() => latestReviews({ week: "2026-W40" }));
  await assertScoped(() => addSuppression({ kind: "person", personId: id, createdBy: "usr_1" }));
  await assertScoped(() => addOptOut(id, { source: "system" }));
  await assertScoped(() => recordPersonEmail({ personId: id, address: "dana@blueharbor.example" }));
  await assertScoped(() => removeSuppression("sup_0", { removedBy: "usr_1" }));
  await assertScoped(() => listSuppression({ limit: 10 }));
  await assertScoped(() => suppressionOf(id, { newEnrollment: true }));
  await assertScoped(() => suppressionsOf([id], { newEnrollment: true, channel: "linkedin" }));
  await assertScoped(() => suppressedAt(id, new Date()));
  await assertScoped(() => lastTouchAt(id));
  await assertScoped(() => recordTouch(id, new Date()));
  await assertScoped(() => recordLeadStatus(id, "approved", { actor: { type: "system" } }));
  await assertScoped(() => approveLead(id));
  await assertScoped(() => listStatusChanges(id));
  await assertScoped(() => editLeadPerson(id, { title: "Head of Data" }));
  await assertScoped(() => createLeadByMember({ linkedinUrl, firstName: "Dana" }));
  await assertScoped(() => importExclusionList(exclusions));
  await assertScoped(() => listExclusionLists({ limit: 10 }));
  await assertScoped(() => removeExclusionList("exl_0", { removedBy: "usr_1" }));
});

// The company index across organizations (gamma-rf-010), on tenancy's workspaces.
const page = "https://linkedin.com/company/blue-harbor-labs";
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 8));
/** Two organizations, the first with a second workspace: [A, A2, B]. */
async function threeWorkspaces() {
  useTenancyClient(asRole("app"));
  const [a, b] = await createTwoWorkspaces();
  const { workspace } = await createWorkspace({
    organizationId: a.organization.id,
    name: "Second",
    slug: "second",
    ownerUserId: a.user.id,
  });
  return [a.workspace.id, workspace.id, b.workspace.id] as const;
}
const write = (workspaceId: string, source: string, provider: string, company: object) =>
  run(workspaceId, async () => {
    const written = { name: "Blue Harbor Labs", linkedinUrl: page, ...company };
    return (await upsertCompany({ source: source as "import", provider, company: written }))
      .company;
  });

test("across organizations: an open_data fact one organization's run brings is read by another's with its provenance; a linkedin, an import or a left-out class's fact by every workspace of its organization and no other; with the setting empty, none crosses", async () => {
  const [a, a2, b] = await threeWorkspaces();
  await write(a, "linkedin", "unipile", { sizeRange: "11-50", fetchedAt: at(1) });
  await write(a, "open_data", "wikidata", { industry: "Software", fetchedAt: at(2) });
  await write(a, "import", "csv", { country: "DE", fetchedAt: at(3) });
  await write(a, "web_search", "brave", { description: "Ships data.", fetchedAt: at(4) });
  const theirs = await write(b, "linkedin", "unipile", { fetchedAt: at(5) });
  const openData = { source: "open_data", provider: "wikidata", at: at(2).toISOString() };
  for (const read of [theirs, await run(b, () => getCompany(theirs.id))]) {
    assert.deepEqual([read.industry, read.fieldProvenance.industry], ["Software", openData]);
    assert.deepEqual([read.sizeRange, read.country, read.description], [null, null, null]);
  }
  const second = await write(a2, "linkedin", "unipile", { fetchedAt: at(5) });
  const ours = await run(a2, () => refreshCompany(second.id));
  assert.deepEqual(
    [ours.industry, ours.sizeRange, ours.country, ours.description],
    ["Software", "11-50", "DE", "Ships data."],
  );
  useSharedFactSources([]);
  await write(a, "open_data", "wikidata", { employeeCount: 40, fetchedAt: at(6) });
  useSharedFactSources(undefined);
  assert.equal((await run(b, () => getCompany(theirs.id))).employeeCount, null);
  assert.equal((await run(a2, () => getCompany(second.id))).employeeCount, 40);
});

test("two workspaces of one organization: a domain one found through LinkedIn reaches the other's row at its next refreshCompany, and a block on it then matches there; another organization's row never gets it", async () => {
  const [a, a2, b] = await threeWorkspaces();
  const personAt = (workspaceId: string) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      const company = { name: "Blue Harbor Labs", linkedinUrl: page };
      const { id: companyId } = (
        await upsertCompany({ source: "linkedin", provider: "unipile", company })
      ).company;
      await linkPersonToCompany({ personId, companyId });
      return { personId, companyId };
    });
  const [, ours, theirs] = [await personAt(a), await personAt(a2), await personAt(b)];
  await write(a, "linkedin", "unipile", { domain: "blueharbor.example", fetchedAt: at(2) });
  const blocked = (workspaceId: string, personId: string) =>
    run(workspaceId, async () => {
      await addSuppression({ kind: "company", value: "blueharbor.example", createdBy: "usr_a" });
      return suppressionOf(personId, { newEnrollment: true });
    });
  const check = (workspaceId: string, personId: string) =>
    run(workspaceId, () => suppressionOf(personId, { newEnrollment: true }));
  assert.deepEqual(await blocked(a2, ours.personId), { suppressed: false }, "before the refresh");
  const refreshed = await run(a2, () => refreshCompany(ours.companyId));
  const linkedin = { source: "linkedin", provider: "unipile", at: at(2).toISOString() };
  assert.deepEqual(
    [refreshed.domain, refreshed.fieldProvenance.domain],
    ["blueharbor.example", linkedin],
  );
  assert.deepEqual(await check(a2, ours.personId), {
    suppressed: true,
    reason: "never_contact_company",
  });
  assert.equal((await run(b, () => refreshCompany(theirs.companyId))).domain, null);
  assert.deepEqual(await blocked(b, theirs.personId), { suppressed: false });
});

test("the key that made a shared company never leaves its organization: A's LinkedIn page makes it and an open_data domain joins it; B, linked by the domain, reads no page after refreshCompany, and A's second workspace copies the page down with its stamp", async () => {
  const [a, a2, b] = await threeWorkspaces();
  await write(a, "linkedin", "unipile", { fetchedAt: at(1) });
  await write(a, "open_data", "wikidata", { domain: "blueharbor.example", fetchedAt: at(2) });
  const byDomain = (workspaceId: string) =>
    run(workspaceId, async () => {
      const company = { name: "Blue Harbor Labs", domain: "blueharbor.example" };
      const { id } = (await upsertCompany({ source: "import", provider: "csv", company })).company;
      return refreshCompany(id);
    });
  const theirs = await byDomain(b);
  assert.deepEqual([theirs.domain, theirs.linkedinUrl], ["blueharbor.example", null]);
  const ours = await byDomain(a2);
  const linkedin = { source: "linkedin", provider: "unipile", at: at(1).toISOString() };
  assert.deepEqual([ours.linkedinUrl, ours.fieldProvenance.linkedinUrl], [page, linkedin]);
});

test("app holds no DELETE on companies or group_companies: 42501, by SQL or through the tenant client", async () => {
  const [a] = await threeWorkspaces();
  await write(a, "linkedin", "unipile", { sizeRange: "11-50" });
  const app = asRole("app");
  assert.equal(await sqlstate(app.$executeRaw`DELETE FROM companies`), "42501");
  assert.equal(await sqlstate(app.$executeRaw`DELETE FROM group_companies`), "42501");
  const byClient = run(a, async (tx) => {
    await tx.sharedCompany.deleteMany({});
  });
  assert.equal(await sqlstate(byClient), "42501");
  const groups = run(a, async (tx) => {
    await tx.groupCompany.deleteMany({});
  });
  assert.equal(await sqlstate(groups), "42501");
});
