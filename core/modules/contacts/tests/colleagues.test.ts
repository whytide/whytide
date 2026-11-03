// colleaguesOf (beta-p3-020), messaging's read for the colleague-signal gate, on the worktree's
// database in this file's schema: the other persons of the workspace at the person's company, by its
// company_id, else by the same company_name case aside; never the person, never another workspace's.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { colleaguesOf, upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const A = "wsp_colleagues_a";
const B = "wsp_colleagues_b";
const HARBOR = "Blue Harbor Labs";

/** A person of the workspace, at the company page when given, with the company name when given. */
async function personIn(
  workspaceId: string,
  name: string,
  company: { page?: string; name?: string } = {},
): Promise<string> {
  const [firstName = "", lastName = ""] = name.split(" ");
  return run(workspaceId, async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${firstName}-${lastName}`.toLowerCase(),
      firstName,
      lastName,
      ...(company.name !== undefined && { companyName: company.name }),
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    if (company.page === undefined) return person.id;
    const page = { name: company.name ?? HARBOR, linkedinUrl: company.page };
    const upserted = await upsertCompany({ source: "linkedin", provider: null, company: page });
    await linkPersonToCompany({ personId: person.id, companyId: upserted.company.id });
    return person.id;
  });
}

const namesOf = async (workspaceId: string, personId: string) =>
  (await run(workspaceId, () => colleaguesOf(personId)))
    .map(({ firstName, lastName }) => `${firstName} ${lastName}`)
    .sort();

test("by company id: the other persons linked to the person's company, never the person, never one of another company, without a company id or in another workspace", async () => {
  const harbor = "https://linkedin.com/company/blue-harbor";
  const ada = await personIn(A, "Ada Example", { page: harbor, name: HARBOR });
  await personIn(A, "Ben Harbor", { page: harbor, name: HARBOR });
  await personIn(A, "Cleo Harbor", { page: harbor });
  await personIn(A, "Dan Named", { name: HARBOR });
  await personIn(A, "Eli Northwind", { page: "https://linkedin.com/company/northwind" });
  await personIn(B, "Fay Harbor", { page: harbor, name: HARBOR });

  assert.deepEqual(await namesOf(A, ada), ["Ben Harbor", "Cleo Harbor"]);
  const [colleague] = await run(A, () => colleaguesOf(ada));
  assert.deepEqual(Object.keys(colleague ?? {}).sort(), ["firstName", "lastName"]);
});

test("by company name, case aside, for a person with no company id: never the person, never another workspace's; none for a person with neither; person_not_found for an unknown id or another workspace's person", async () => {
  const gus = await personIn(A, "Gus Named", { name: HARBOR });
  await personIn(A, "Hal Upper", { name: HARBOR.toUpperCase() });
  await personIn(A, "Ida Linked", {
    page: "https://linkedin.com/company/blue-harbor",
    name: HARBOR,
  });
  await personIn(A, "Jon Other", { name: "Blue Harbor" });
  await personIn(B, "Kai Named", { name: HARBOR });
  const kim = await personIn(A, "Kim Nowhere");
  await personIn(A, "Lou Nowhere");

  assert.deepEqual(await namesOf(A, gus), ["Hal Upper", "Ida Linked"]);
  assert.deepEqual(await namesOf(A, kim), []);
  const unknown = "per_00000000000000000000000000";
  await assert.rejects(
    run(A, () => colleaguesOf(unknown)),
    { code: "person_not_found" },
  );
  await assert.rejects(
    run(B, () => colleaguesOf(gus)),
    { code: "person_not_found" },
  );
});

test("colleaguesOf goes through the tenant client of the caller's run", async () => {
  await assertScoped(() => colleaguesOf("per_00000000000000000000000000"));
});
