// contacts' review decisions on the worktree's database (alpha-p9-040), in this file's schema: what
// the routes' test, core/apps/api/tests/contacts-review.test.ts, cannot reach. A decision is
// append-only, as app cannot update one, and erasePerson deletes the person's with the lead.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createLeadForPerson } from "../domain/leads.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import { reviewLead } from "../domain/review/reviews.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: "wsp_review_test", principal }, fn, { client: asRole("app") });

test("a decision is append-only: app cannot update one; erasePerson deletes the person's decisions with the lead", async () => {
  const personId = await run(async () => {
    const profile = { linkedinUrl: "https://linkedin.com/in/rae-sample", firstName: "Rae" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
  const good = {
    personId,
    decision: "good_lead",
    goodReasonText: "Hiring data engineers",
  } as const;
  await run(() => reviewLead(good));
  await run(() => reviewLead({ personId, decision: "not_a_fit", reasonCode: "bad_timing" }));
  const app = asRole("app");
  assert.equal(await app.reviewDecision.count(), 2);
  const update = app.$executeRaw`UPDATE review_decisions SET reason_code = 'other'`;
  assert.equal(await sqlstate(update), "42501", "app must not update a decision");

  const { counts } = await run(() => erasePerson(personId));
  assert.deepEqual(counts, { review_decisions: 2, leads: 1, persons: 1 });
  const left = [app.reviewDecision.count(), app.lead.count(), app.person.count()];
  assert.deepEqual(await Promise.all(left), [0, 0, 0]);
});
