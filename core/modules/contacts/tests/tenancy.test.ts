// test:tenancy for contacts' seven tables (docs/rules/security.md §3; core/packages/db README
// "Register a tenant table in the isolation test"): the same person, company, hash, lead (with its
// source's label), review decision, never-contact entry and status change in workspaces A and B are
// two rows, each read by the module's scoped query in its own workspace only; an entry in A
// suppresses no one in B; the database refuses a link across workspaces; and every public command
// and query goes through the tenant client of the caller's run.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createLeadsForPersons, upsertPersonsFromSource } from "../domain/batch.ts";
import { getCompany, linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { isHashed, purgeExpiredHashes, recordHash } from "../domain/hashes.ts";
import {
  applyQualification,
  createLeadForPerson,
  getLead,
  leadNeighbours,
  leadsPendingQualification,
  listLeads,
} from "../domain/leads.ts";
import { approveLead, listStatusChanges, recordLeadStatus } from "../domain/outreach/status.ts";
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
} from "../domain/suppression/checks.ts";
import {
  addOptOut,
  addSuppression,
  listSuppression,
  removeSuppression,
} from "../domain/suppression/entries.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
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

test("an entry in one workspace suppresses no one in another: the same person and company in B stay allowed", async () => {
  const atCompany = async (workspaceId: string) =>
    run(workspaceId, async () => {
      const { id: personId } = (await upsertPersonFromSource(person)).person;
      const { id: companyId } = (await upsertCompany(company)).company;
      await linkPersonToCompany({ personId, companyId });
      return personId;
    });
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
  await assertScoped(() => reviewLead({ personId: id, ...notAFit }));
  await assertScoped(() => listReviews(id));
  await assertScoped(() => reviewSummary("2026-W40"));
  await assertScoped(() => latestReviews({ week: "2026-W40" }));
  await assertScoped(() => addSuppression({ kind: "person", personId: id, createdBy: "usr_1" }));
  await assertScoped(() => addOptOut(id, { source: "system" }));
  await assertScoped(() => removeSuppression("sup_0", { removedBy: "usr_1" }));
  await assertScoped(() => listSuppression({ limit: 10 }));
  await assertScoped(() => suppressionOf(id, { newEnrollment: true }));
  await assertScoped(() => suppressedAt(id, new Date()));
  await assertScoped(() => lastTouchAt(id));
  await assertScoped(() => recordTouch(id, new Date()));
  await assertScoped(() => recordLeadStatus(id, "approved", { actor: { type: "system" } }));
  await assertScoped(() => approveLead(id));
  await assertScoped(() => listStatusChanges(id));
});
