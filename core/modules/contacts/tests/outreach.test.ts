// contacts' outreach status on the worktree's database (beta-p2-030), in this file's schema, each
// command inside a tenant run as its callers make one: recordLeadStatus's one row per change and none
// without one, the Qualified date it leaves, the suppression write of a person's, a company's and an
// opt-out entry in the entry's own transaction, Approve's rules and its event, and what erasure
// deletes. The routes' test is the api host's, core/apps/api/tests/contacts-approve.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { type Principal, servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { OUTREACH_STATUSES, type OutreachStatus } from "../domain/outreach/constants.ts";
import { approvableFrom } from "../domain/outreach/rules.ts";
import { approveLead, listStatusChanges, recordLeadStatus } from "../domain/outreach/status.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import { reviewLead } from "../domain/review/reviews.ts";
import { recordTouch } from "../domain/suppression/checks.ts";
import { addOptOut, addSuppression, removeSuppression } from "../domain/suppression/entries.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WORKSPACE = "wsp_contacts_outreach";
const USER = "usr_outreach_tester";
const tester: Principal = { userId: USER, actorType: "human", authMethod: "session", scopes: [] };
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** As the tester, the way the approve route runs. */
const asTester = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal: tester }, fn, { client: asRole("app") });
const system = { type: "system" } as const;
const app = () => asRole("app");

/** A person of the workspace with a lead, at a company with the domain or page given; its id. */
async function leadAt(slug: string, company?: { domain?: string; linkedinUrl?: string }) {
  return run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    if (company === undefined) return person.id;
    const { company: row } = await upsertCompany({
      source: "import",
      provider: "csv",
      company: { name: `Company of ${slug}`, ...company },
    });
    await linkPersonToCompany({ personId: person.id, companyId: row.id });
    return person.id;
  });
}
const lead = (personId: string) => app().lead.findFirstOrThrow({ where: { personId } });
const statusOf = async (personId: string) => (await lead(personId)).outreachStatus;
const changesOf = (personId: string) =>
  app().leadStatusChange.findMany({
    where: { personId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
const approvals = async () => {
  const where = { workspaceId: WORKSPACE, eventName: "contacts.lead_approved" };
  return (await app().outboxEntry.findMany({ where, orderBy: { createdAt: "asc" } })).map(
    (row) => row.payload,
  );
};
const block = (input: Omit<Parameters<typeof addSuppression>[0], "createdBy">) =>
  run(() => addSuppression({ ...input, createdBy: USER }));

test("recordLeadStatus writes one row per change and none without one, and leaves the Qualified date (updated_at)", async () => {
  const personId = await leadAt("noor-record");
  const before = await lead(personId);
  assert.equal(before.outreachStatus, "pending_review");
  const options = { reason: "removed", templateId: "tpl_1", actor: system };
  const written = await run(() => recordLeadStatus(personId, "in_campaign", options));
  assert.equal(await run(() => recordLeadStatus(personId, "in_campaign", { actor: system })), null);
  const user = { type: "user", id: USER } as const;
  await run(() => recordLeadStatus(personId, "finished", { actor: user }));
  const after = await lead(personId);
  assert.equal(after.outreachStatus, "finished");
  assert.equal(after.outreachReason, null, "a change without a reason empties the last one");
  assert.deepEqual(after.updatedAt, before.updatedAt, "the Qualified date stays");
  const changes = await changesOf(personId);
  assert.deepEqual(
    changes.map(({ fromStatus, toStatus, templateId, reason, actorType, actorId }) => ({
      fromStatus,
      toStatus,
      templateId,
      reason,
      actorType,
      actorId,
    })),
    [
      {
        fromStatus: "pending_review",
        toStatus: "in_campaign",
        templateId: "tpl_1",
        reason: "removed",
        actorType: "system",
        actorId: null,
      },
      {
        fromStatus: "in_campaign",
        toStatus: "finished",
        templateId: null,
        reason: null,
        actorType: "user",
        actorId: USER,
      },
    ],
  );
  assert.equal(written?.id, changes[0]?.id);
  assert.match(changes[0]?.id ?? "", /^lsc_[0-9A-Z]{26}$/);
  const listed = await run(() => listStatusChanges(personId));
  assert.deepEqual(
    listed.map(({ toStatus }) => toStatus),
    ["finished", "in_campaign"],
    "newest first",
  );
});

test("recordLeadStatus refuses an unknown lead and an input off its rules, and writes nothing", async () => {
  const personId = await leadAt("noor-refused");
  await assert.rejects(
    run(() => recordLeadStatus("per_unknown", "approved", { actor: system })),
    { code: "lead_not_found" },
  );
  const calls = [
    () => recordLeadStatus(personId, "meeting_booked" as OutreachStatus, { actor: system }),
    () => recordLeadStatus(personId, "approved", { reason: "Not A Code", actor: system }),
    () => recordLeadStatus(personId, "approved", { actor: { type: "user" } as never }),
    () => recordLeadStatus(personId, "approved", { actor: { type: "system", id: USER } as never }),
  ];
  for (const call of calls) {
    await assert.rejects(run(call), { code: "contacts_input_invalid" });
  }
  await assert.rejects(
    run(() => listStatusChanges("per_unknown")),
    { code: "lead_not_found" },
  );
  assert.equal(await statusOf(personId), "pending_review");
  assert.equal(await app().leadStatusChange.count(), 0);
});

test("a person's entry and an opt-out set suppressed on the person's lead, with a change row, once", async () => {
  const blocked = await leadAt("noor-blocked");
  const optedOut = await leadAt("noor-opted-out");
  const other = await leadAt("noor-other");
  await block({ kind: "person", personId: blocked });
  await block({ kind: "person", value: "https://www.linkedin.com/in/NOOR-BLOCKED/" });
  await run(() => addOptOut(optedOut, { source: "system", reason: "reply_opt_out" }));
  await run(() => addOptOut(blocked, { source: "manual", createdBy: USER }));
  assert.deepEqual(
    [await statusOf(blocked), await statusOf(optedOut), await statusOf(other)],
    ["suppressed", "suppressed", "pending_review"],
  );
  const rows = await app().leadStatusChange.findMany({ orderBy: { personId: "asc" } });
  assert.deepEqual(
    rows
      .map(({ personId, fromStatus, toStatus, reason, actorType, actorId }) => ({
        personId,
        fromStatus,
        toStatus,
        reason,
        actorType,
        actorId,
      }))
      .sort((a, b) => (a.reason ?? "").localeCompare(b.reason ?? "")),
    [
      {
        personId: blocked,
        fromStatus: "pending_review",
        toStatus: "suppressed",
        reason: "never_contact_person",
        actorType: "user",
        actorId: USER,
      },
      {
        personId: optedOut,
        fromStatus: "pending_review",
        toStatus: "suppressed",
        reason: "opted_out",
        actorType: "system",
        actorId: null,
      },
    ],
    "one row each: the second entry and the opt-out on a suppressed lead write none",
  );
  assert.equal((await lead(optedOut)).outreachReason, "opted_out");
});

test("a company's entry sets suppressed on the leads of the persons whose company it matches: its domain and subdomains, or its page", async () => {
  const atDomain = await leadAt("noor-harbor", { domain: "harbor.example" });
  const atSub = await leadAt("noor-eu-harbor", { domain: "eu.harbor.example" });
  const lookalike = await leadAt("noor-notharbor", { domain: "notharbor.example" });
  const atPage = await leadAt("noor-quay", { linkedinUrl: "https://linkedin.com/company/quay" });
  const elsewhere = await leadAt("noor-elsewhere");
  await block({ kind: "company", value: "harbor.example" });
  await block({ kind: "company", value: "https://www.linkedin.com/company/QUAY/" });
  const statuses = await Promise.all([atDomain, atSub, lookalike, atPage, elsewhere].map(statusOf));
  assert.deepEqual(statuses, [
    "suppressed",
    "suppressed",
    "pending_review",
    "suppressed",
    "pending_review",
  ]);
  for (const personId of [atDomain, atSub, atPage]) {
    const [change, ...more] = await changesOf(personId);
    assert.equal(more.length, 0);
    assert.equal(change?.reason, "never_contact_company");
  }
});

test("the suppression write runs in the entry's transaction: a run that fails after the add keeps neither", async () => {
  const personId = await leadAt("noor-rolled-back");
  await assert.rejects(
    run(async () => {
      await addSuppression({ kind: "person", personId, createdBy: USER });
      assert.equal((await lead(personId)).outreachStatus, "pending_review", "not committed yet");
      throw new Error("the caller fails after the add");
    }),
    /the caller fails after the add/,
  );
  assert.equal(await statusOf(personId), "pending_review");
  assert.equal(await app().suppressionEntry.count(), 0);
  assert.equal(await app().leadStatusChange.count(), 0);
});

test("Approve's rules: from pending_review, approved and suppressed without a campaign; never from in_campaign, replied or finished", () => {
  const allowed = OUTREACH_STATUSES.filter((status) => approvableFrom(status, false));
  assert.deepEqual(allowed, ["pending_review", "approved", "suppressed"]);
  const afterCampaign = OUTREACH_STATUSES.filter((status) => approvableFrom(status, true));
  assert.deepEqual(afterCampaign, ["pending_review", "approved"]);
});

test("Approve sets approved with one change row and publishes contacts.lead_approved; again from approved it publishes again and writes no row; the Qualified date stays", async () => {
  const personId = await leadAt("noor-approve");
  const before = await lead(personId);
  assert.equal(await asTester(() => approveLead(personId)), "approved");
  assert.equal(await asTester(() => approveLead(personId)), "approved");
  const after = await lead(personId);
  assert.equal(after.outreachStatus, "approved");
  assert.deepEqual(after.updatedAt, before.updatedAt, "the Qualified date stays");
  const changes = await changesOf(personId);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.actorType, "user");
  assert.equal(changes[0]?.actorId, USER);
  const payload = { personId, approvedBy: USER };
  assert.deepEqual(await approvals(), [payload, payload]);
  await assert.rejects(
    asTester(() => approveLead("per_unknown")),
    { code: "lead_not_found" },
  );
});

test("Approve is independent of review: Good lead and Not a fit leave the outreach status, and a Not a fit lead can be approved", async () => {
  const good = await leadAt("noor-good");
  const notAFit = await leadAt("noor-not-a-fit");
  await run(() => reviewLead({ personId: good, decision: "good_lead", goodReasonText: "Hiring" }));
  await run(() =>
    reviewLead({ personId: notAFit, decision: "not_a_fit", reasonCode: "bad_timing" }),
  );
  assert.deepEqual(
    [await statusOf(good), await statusOf(notAFit)],
    ["pending_review", "pending_review"],
  );
  await asTester(() => approveLead(notAFit));
  await run(() =>
    reviewLead({ personId: notAFit, decision: "good_lead", goodReasonText: "Later" }),
  );
  assert.equal(await statusOf(notAFit), "approved", "a decision after Approve leaves it too");
});

test("Approve refuses a suppressed person with the reason, recently_contacted included; once unblocked the lead is approved again, unless it was ever in a campaign", async () => {
  const blocked = await leadAt("noor-approve-blocked");
  const touched = await leadAt("noor-approve-touched");
  const campaigned = await leadAt("noor-approve-campaigned");
  const { entry } = await block({ kind: "person", personId: blocked });
  await assert.rejects(
    asTester(() => approveLead(blocked)),
    {
      code: "person_suppressed",
      details: { reason: "never_contact_person" },
    },
  );
  await run(() => recordTouch(touched, new Date()));
  await assert.rejects(
    asTester(() => approveLead(touched)),
    {
      code: "person_suppressed",
      details: { reason: "recently_contacted" },
    },
  );
  assert.equal(await statusOf(touched), "pending_review", "a refusal writes nothing");

  await run(() => removeSuppression(entry.id, { removedBy: USER }));
  assert.equal(await statusOf(blocked), "suppressed", "removing the block leaves the status");
  assert.equal(await asTester(() => approveLead(blocked)), "approved");
  const back = await changesOf(blocked);
  assert.deepEqual(
    back.map(({ fromStatus, toStatus }) => [fromStatus, toStatus]),
    [
      ["pending_review", "suppressed"],
      ["suppressed", "approved"],
    ],
  );

  await run(() =>
    recordLeadStatus(campaigned, "in_campaign", { templateId: "tpl_1", actor: system }),
  );
  for (const status of ["in_campaign", "replied", "finished"] as const) {
    await run(() => recordLeadStatus(campaigned, status, { actor: system }));
    await assert.rejects(
      asTester(() => approveLead(campaigned)),
      { code: "lead_in_outreach" },
    );
  }
  const { entry: again } = await block({ kind: "person", personId: campaigned });
  assert.equal(await statusOf(campaigned), "suppressed");
  await run(() => removeSuppression(again.id, { removedBy: USER }));
  await assert.rejects(
    asTester(() => approveLead(campaigned)),
    { code: "lead_in_outreach" },
  );
  assert.equal(await statusOf(campaigned), "suppressed");
  assert.deepEqual(await approvals(), [{ personId: blocked, approvedBy: USER }]);
});

test("a status change is append-only: app cannot update one; erasePerson deletes the person's with the lead, its counts as they were", async () => {
  const personId = await leadAt("noor-erased");
  const kept = await leadAt("noor-kept");
  await asTester(() => approveLead(personId));
  await asTester(() => approveLead(kept));
  const update = app().$executeRaw`UPDATE lead_status_changes SET reason = 'other'`;
  assert.equal(await sqlstate(update), "42501", "app must not update a status change");

  const { counts } = await run(() => erasePerson(personId));
  assert.deepEqual(counts, { review_decisions: 0, leads: 1, persons: 1 });
  assert.equal(await app().leadStatusChange.count({ where: { personId } }), 0);
  assert.equal(await app().leadStatusChange.count({ where: { personId: kept } }), 1);
});
