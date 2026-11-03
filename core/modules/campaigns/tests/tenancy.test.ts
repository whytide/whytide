// test:tenancy for campaigns' tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): an enrollment and its step executions, made by enrolling an
// approved lead and read in a run of one workspace through the scoped client (the module has no
// query yet), are that workspace's only; erasePerson deletes the person's rows and nobody else's; and
// enrolling and erasing go through the tenant client.
import assert from "node:assert/strict";
import test from "node:test";
import { createLeadForPerson, recordLeadStatus, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { createConnectedAccount, useLinkedinClient } from "@whytide/linkedin/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { enrollApproved } from "../domain/enroll/enroll.ts";
import { erasePerson } from "../domain/erase.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const client = asRole("app");
useLinkedinClient(client);
const APPROVER = "usr_campaigns_tenancy";
const principal = servicePrincipal("campaigns_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

/** A lead of the workspace, approved by APPROVER and enrolled by the subscriber's body: its id. */
const enrolled = (workspaceId: string, slug: string) =>
  inRun(workspaceId, async (tx) => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    // Approved, as Approve leaves the lead: only an approved lead is enrolled.
    await recordLeadStatus(person.id, "approved", { actor: { type: "user", id: APPROVER } });
    const approval = { sourceEventId: newId("obx"), personId: person.id, approvedBy: APPROVER };
    assert.equal(await enrollApproved(tx, approval), "enrolled");
    return person.id;
  });
/** A workspace whose APPROVER has a connected account, with one enrolled lead: the person's id. */
async function enrolledIn(workspaceId: string): Promise<string> {
  await createConnectedAccount(workspaceId, { ownerUserId: APPROVER });
  return enrolled(workspaceId, "tenancy");
}

isolationTest("enrollments", {
  async createRow(workspaceId) {
    const personId = await enrolledIn(workspaceId);
    return inRun(workspaceId, () =>
      tenantClient.enrollment.findFirstOrThrow({ where: { personId } }),
    );
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.enrollment.findMany()),
});

isolationTest("step_executions", {
  async createRow(workspaceId) {
    const personId = await enrolledIn(workspaceId);
    const where = { personId, stepKey: "connect" };
    return inRun(workspaceId, () => tenantClient.stepExecution.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.stepExecution.findMany()),
});

test("erasePerson deletes the person's step executions and enrollments, and nobody else's", async () => {
  const [a, b] = ["wsp_campaigns_erase_a", "wsp_campaigns_erase_b"];
  const gone = await enrolledIn(a);
  const kept = await enrolled(a, "tenancy-kept");
  const elsewhere = await enrolledIn(b);
  const persons = async () => {
    const rows = [
      ...(await client.enrollment.findMany({ select: { personId: true } })),
      ...(await client.stepExecution.findMany({ select: { personId: true } })),
    ];
    return rows.map(({ personId }) => personId).sort();
  };
  const before = await persons();
  assert.equal(before.length, 15, "three enrollments, twelve steps");

  const erased = await inRun(a, () => erasePerson(gone));
  assert.deepEqual(erased, { step_executions: 4, enrollments: 1 });
  assert.deepEqual(
    await persons(),
    before.filter((personId) => personId !== gone),
  );
  assert.deepEqual(new Set(await persons()), new Set([kept, elsewhere]));
  // Again, nothing is left to delete; no id is refused before any delete runs.
  assert.deepEqual(await inRun(a, () => erasePerson(gone)), { step_executions: 0, enrollments: 0 });
  await assert.rejects(
    inRun(a, () => erasePerson(" ")),
    { code: "person_not_found" },
  );
  assert.equal((await persons()).length, 10);
});

test("enrolling and erasing go through the tenant client", async () => {
  const approval = { sourceEventId: "obx_unknown", personId: "per_unknown", approvedBy: APPROVER };
  await assertScoped(() => enrollApproved(tenantClient, approval));
  await assertScoped(() => erasePerson("per_unknown"));
});
