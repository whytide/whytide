// findPersonsByNameAtCompany (gamma-wr-060), a research run's read before it makes a person: the
// workspace's persons at a company by their whole name, accents, case, punctuation and spacing aside,
// by the company's id or by its name; never a person of another company or workspace; none for a name
// held by nobody there; two ids for a name held twice; made-up names of two scripts and countries.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { findPersonsByNameAtCompany, nameKey } from "../domain/person-match.ts";
import { upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const A = "wsp_match_a";
const B = "wsp_match_b";

let n = 0;
/** A person of the workspace with the names, at the company name and the company row when given. */
async function personIn(
  workspaceId: string,
  names: { firstName: string; lastName: string },
  at: { companyName?: string; domain?: string } = {},
): Promise<string> {
  n += 1;
  return run(workspaceId, async () => {
    const profile = {
      ...{ linkedinUrl: `https://www.linkedin.com/in/match-person-${n}`, ...names },
      ...(at.companyName === undefined ? {} : { companyName: at.companyName }),
    };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    if (at.domain === undefined) return person.id;
    const company = { name: at.companyName ?? at.domain, domain: at.domain };
    const { company: stored } = await upsertCompany({
      source: "website",
      provider: "website",
      company,
    });
    await linkPersonToCompany({ personId: person.id, companyId: stored.id });
    return person.id;
  });
}
const companyOf = (workspaceId: string, domain: string) =>
  run(workspaceId, async () => {
    const { company } = await upsertCompany({
      ...{ source: "website", provider: "website" },
      company: { name: domain, domain },
    });
    return company.id;
  });

test("nameKey folds accents, case, punctuation and spacing, and keeps letters of every script", () => {
  assert.equal(nameKey("  José  María  Núñez-Álvarez "), "jose maria nunez alvarez");
  assert.equal(nameKey("Łukasz O'Brien"), "łukasz o brien");
  assert.equal(nameKey("李 小龍"), "李 小龍");
  assert.equal(nameKey("..."), "");
});

test("a name is matched at the company by its id and by its company name, accents and case aside, whole name only", async () => {
  const lena = await personIn(
    A,
    { firstName: "Léna", lastName: "Okafor" },
    { companyName: "Nordlicht GmbH", domain: "nordlicht.example" },
  );
  const byName = await personIn(
    A,
    { firstName: "Tomas", lastName: "Reyes" },
    { companyName: "NORDLICHT gmbh" },
  );
  await personIn(A, { firstName: "Tomas", lastName: "Reyes" }, { companyName: "Other Co" });
  await personIn(A, { firstName: "Lena", lastName: "Other" }, { domain: "nordlicht.example" });
  await personIn(B, { firstName: "Lena", lastName: "Okafor" }, { domain: "nordlicht.example" });
  const companyId = await companyOf(A, "nordlicht.example");

  await run(A, async () => {
    const find = findPersonsByNameAtCompany;
    assert.deepEqual(await find({ name: "lena okafor", companyId }), [lena]);
    assert.deepEqual(await find({ name: "LÉNA  OKAFOR", companyName: "Nordlicht GmbH" }), [lena]);
    assert.deepEqual(await find({ name: "Tomas Reyes", companyName: "Nordlicht GmbH" }), [byName]);
    assert.deepEqual(await find({ name: "Lena", companyId }), []);
    assert.deepEqual(await find({ name: "Okafor", companyId }), []);
    assert.deepEqual(
      await find({ name: "Nobody Here", companyId, companyName: "Nordlicht GmbH" }),
      [],
    );
  });
});

test("a name held twice at the company answers both ids, in id order", async () => {
  const first = await personIn(
    A,
    { firstName: "Ana", lastName: "Duarte" },
    { companyName: "Sol Frio" },
  );
  const second = await personIn(
    A,
    { firstName: "ana", lastName: "DUARTE" },
    { companyName: "Sol Frio" },
  );
  const ids = await run(A, () =>
    findPersonsByNameAtCompany({ name: "Ana Duarte", companyName: "Sol Frio" }),
  );
  assert.deepEqual(ids, [first, second].sort());
});

test("no company, or a blank name, is contacts_input_invalid; a name that folds to nothing matches nobody", async () => {
  await run(A, async () => {
    await assert.rejects(findPersonsByNameAtCompany({ name: "Ana Duarte" }), {
      code: "contacts_input_invalid",
    });
    await assert.rejects(findPersonsByNameAtCompany({ name: "  ", companyName: "Sol Frio" }), {
      code: "contacts_input_invalid",
    });
    assert.deepEqual(
      await findPersonsByNameAtCompany({ name: "...", companyName: "Sol Frio" }),
      [],
    );
  });
});

test("findPersonsByNameAtCompany goes through the tenant client of the caller's run", async () => {
  await assertScoped(() =>
    findPersonsByNameAtCompany({ name: "Ana Duarte", companyName: "Sol Frio" }),
  );
});
