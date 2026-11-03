// The safety cases of the never-contact list (beta-p2-010; docs/security.md "Suppression"), run by
// `pnpm -F contacts test:safety` and not by `test`: whoever is on the list, at a listed company or
// opted out is never answered "not suppressed", by the check before an action or by the list as it
// stood at an instant; an opt-out is never removed, by the command or by a direct write; removing a
// block leaves an opt-out in force; a person the check does not know is suppressed.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../../domain/companies.ts";
import { upsertPersonFromSource } from "../../domain/persons.ts";
import { suppressedAt, suppressionOf } from "../../domain/suppression/checks.ts";
import { addOptOut, addSuppression, removeSuppression } from "../../domain/suppression/entries.ts";
import { useHashSalt } from "../../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_safety");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: "wsp_contacts_safety", principal }, fn, { client: asRole("app") });
const USER = "usr_safety_tester";

/** A person of the workspace, at the company with that domain or page when one is given. */
async function personAt(slug: string, company?: { domain?: string; linkedinUrl?: string }) {
  return run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    if (company === undefined) return person.id;
    const name = `Company of ${slug}`;
    const { company: row } = await upsertCompany({
      source: "import",
      provider: "csv",
      company: { name, ...company },
    });
    await linkPersonToCompany({ personId: person.id, companyId: row.id });
    return person.id;
  });
}

/** Every answer the module gives about the person: before an action, inside one, and as of now. */
const answers = (personId: string) =>
  run(async () => [
    await suppressionOf(personId, { newEnrollment: true }),
    await suppressionOf(personId, { newEnrollment: false }),
    await suppressedAt(personId, new Date()),
  ]);
const suppressed = (reason: string) => ({ suppressed: true, reason });

test("nobody on the list, at a listed company or opted out is ever answered not suppressed", async () => {
  const clear = await personAt("safety-clear", { domain: "clear-co.example" });
  const byId = await personAt("safety-blocked-by-id");
  const byValue = await personAt("safety-blocked-by-value");
  const atDomain = await personAt("safety-at-domain", { domain: "blocked-co.example" });
  const atSubdomain = await personAt("safety-at-subdomain", { domain: "eu.blocked-co.example" });
  const atPage = await personAt("safety-at-page", {
    linkedinUrl: "https://www.linkedin.com/company/blocked-page/",
  });
  const optedOut = await personAt("safety-opted-out");
  const pageCompany = await run(async () => {
    const page = "https://linkedin.com/company/blocked-page";
    const { company } = await upsertCompany({
      source: "import",
      provider: "csv",
      company: { name: "Blocked Page", linkedinUrl: page },
    });
    return company.id;
  });
  await run(async () => {
    await addSuppression({ kind: "person", personId: byId, createdBy: USER });
    const url = "HTTPS://WWW.LinkedIn.com/in/Safety-Blocked-By-Value/?trk=x";
    await addSuppression({ kind: "person", value: url, createdBy: USER });
    await addSuppression({ kind: "company", value: "blocked-co.example", createdBy: USER });
    await addSuppression({ kind: "company", companyId: pageCompany, createdBy: USER });
    await addOptOut(optedOut, { source: "system", reason: "reply_opt_out" });
  });

  // The control: the same checks answer a person off the list "not suppressed".
  assert.deepEqual(await answers(clear), [
    { suppressed: false },
    { suppressed: false },
    { suppressed: false },
  ]);
  const cases = [
    [byId, "never_contact_person"],
    [byValue, "never_contact_person"],
    [atDomain, "never_contact_company"],
    [atSubdomain, "never_contact_company"],
    [atPage, "never_contact_company"],
    [optedOut, "opted_out"],
  ] as const;
  for (const [personId, reason] of cases) {
    const expected = suppressed(reason);
    assert.deepEqual(await answers(personId), [expected, expected, expected], personId);
  }
});

test("an opt-out cannot be removed: the command refuses it, and a direct write of removed_at fails the CHECK", async () => {
  const personId = await personAt("safety-opt-out-kept");
  const { entry } = await run(() => addOptOut(personId, { source: "manual", createdBy: USER }));
  await assert.rejects(
    run(() => removeSuppression(entry.id, { removedBy: USER })),
    {
      code: "suppression_not_removable",
    },
  );
  const write = asRole("app").$executeRaw`
    UPDATE suppression_entries SET removed_at = now(), removed_by = ${USER} WHERE id = ${entry.id}`;
  assert.equal(await sqlstate(write), "23514", "check_violation");
  const expected = suppressed("opted_out");
  assert.deepEqual(await answers(personId), [expected, expected, expected]);
});

test("a removed block leaves an opt-out in force", async () => {
  const personId = await personAt("safety-blocked-then-opted-out");
  const { entry: block } = await run(() =>
    addSuppression({ kind: "person", personId, createdBy: USER }),
  );
  await run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));
  await run(() => removeSuppression(block.id, { removedBy: USER }));
  const expected = suppressed("opted_out");
  assert.deepEqual(await answers(personId), [expected, expected, expected]);
});

test("a person the check does not know is suppressed: person_not_found, whatever the id", async () => {
  const expected = suppressed("person_not_found");
  for (const personId of ["per_00000000000000000000000000", "", "x".repeat(65)]) {
    assert.deepEqual(await answers(personId), [expected, expected, expected], personId);
  }
});
