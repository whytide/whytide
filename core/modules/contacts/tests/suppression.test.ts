// contacts' never-contact list end to end (beta-p2-010) on the worktree's database, in this file's
// schema, each command inside a tenant run as its callers make one: the matching, the order of the
// reasons, the 90-day rule, the list as it stood at an instant, the touches, the event, no cache,
// and what erasure keeps. The safety cases are tests/safety/suppression.test.ts; the routes' test is
// the api host's, core/apps/api/tests/contacts-suppression.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import {
  lastTouchAt,
  recordTouch,
  suppressedAt,
  suppressionOf,
} from "../domain/suppression/checks.ts";
import { DAY_MS } from "../domain/suppression/constants.ts";
import { addOptOut, addSuppression, removeSuppression } from "../domain/suppression/entries.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WORKSPACE = "wsp_contacts_suppression";
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal }, fn, { client: asRole("app") });
const USER = "usr_suppression_tester";
const HOUR_MS = 3_600_000;

/** A person of the workspace, at a company with the domain or page given; its id. */
async function personAt(slug: string, company?: { domain?: string; linkedinUrl?: string }) {
  return run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Ines" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
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
const check = (personId: string, newEnrollment = true) =>
  run(() => suppressionOf(personId, { newEnrollment }));
const block = (input: Omit<Parameters<typeof addSuppression>[0], "createdBy">) =>
  run(() => addSuppression({ ...input, createdBy: USER }));
const allowed = { suppressed: false };
const refused = (reason: string) => ({ suppressed: true, reason });

test("matching: a person by id or by value; a company by domain, which holds for its subdomains and not its parent or a lookalike, and by page", async () => {
  const byId = await personAt("ines-by-id");
  const byValue = await personAt("ines-by-value");
  const atDomain = await personAt("ines-harbor", { domain: "harbor.example" });
  const atSub = await personAt("ines-eu-harbor", { domain: "eu.harbor.example" });
  const lookalike = await personAt("ines-notharbor", { domain: "notharbor.example" });
  const atParent = await personAt("ines-coast", { domain: "coast.example" });
  const atPage = await personAt("ines-page", { linkedinUrl: "https://linkedin.com/company/quay" });
  for (const personId of [byId, byValue, atDomain, atSub, lookalike, atParent, atPage]) {
    assert.deepEqual(await check(personId), allowed);
  }
  const quay = await run(async () => {
    const page = { name: "Quay", linkedinUrl: "linkedin.com/company/QUAY/" };
    return (await upsertCompany({ source: "import", provider: "csv", company: page })).company;
  });
  await block({ kind: "person", personId: byId });
  await block({ kind: "person", value: "www.linkedin.com/in/INES-BY-VALUE/?trk=feed" });
  await block({ kind: "company", value: "https://www.harbor.example/about" });
  await block({ kind: "company", value: "west.coast.example" });
  await block({ kind: "company", companyId: quay.id });

  assert.deepEqual(await check(byId), refused("never_contact_person"));
  assert.deepEqual(await check(byValue), refused("never_contact_person"));
  for (const personId of [atDomain, atSub, atPage]) {
    assert.deepEqual(await check(personId), refused("never_contact_company"), personId);
  }
  assert.deepEqual(await check(lookalike), allowed, "notharbor.example is no subdomain");
  assert.deepEqual(await check(atParent), allowed, "an entry on a subdomain leaves its parent");
});

test("the first reason that applies wins: opted_out, never_contact_person, never_contact_company, recently_contacted", async () => {
  const company = { domain: "order.example" };
  const [all, blocked, atCompany, touched] = [
    await personAt("ines-all", company),
    await personAt("ines-blocked", company),
    await personAt("ines-at-company", company),
    await personAt("ines-touched"),
  ];
  const yesterday = new Date(Date.now() - DAY_MS);
  await block({ kind: "company", value: "order.example" });
  for (const personId of [all, blocked]) await block({ kind: "person", personId });
  await run(() => addOptOut(all, { source: "system", reason: "reply_opt_out" }));
  for (const personId of [all, blocked, atCompany, touched]) {
    await run(() => recordTouch(personId, yesterday));
  }
  assert.deepEqual(await check(all), refused("opted_out"));
  assert.deepEqual(await check(blocked), refused("never_contact_person"));
  assert.deepEqual(await check(atCompany), refused("never_contact_company"));
  assert.deepEqual(await check(touched), refused("recently_contacted"));
});

test("the 90-day rule: a touch 91 days ago allows a new enrollment, one 89 days ago refuses it; newEnrollment false never answers recently_contacted", async () => {
  const personId = await personAt("ines-ninety");
  await run(() => recordTouch(personId, new Date(Date.now() - 91 * DAY_MS)));
  assert.deepEqual([await check(personId), await check(personId, false)], [allowed, allowed]);
  await run(() => recordTouch(personId, new Date(Date.now() - 89 * DAY_MS)));
  assert.deepEqual(await check(personId), refused("recently_contacted"));
  assert.deepEqual(await check(personId, false), allowed);
  assert.deepEqual(await run(() => suppressedAt(personId, new Date())), allowed);
});

test("suppressedAt answers the list as it stood: an entry counts from its creation until its removal; the check of now no longer counts a removed block", async () => {
  const personId = await personAt("ines-history");
  const { entry } = await block({ kind: "person", personId });
  await run(() => removeSuppression(entry.id, { removedBy: USER }));
  // Back in time, as the owner: created three hours ago, removed one hour ago.
  const now = Date.now();
  const [created, removed] = [new Date(now - 3 * HOUR_MS), new Date(now - HOUR_MS)];
  await asRole("owner").$executeRaw`
    UPDATE suppression_entries SET created_at = ${created}, removed_at = ${removed}
    WHERE id = ${entry.id}`;
  const at = (instant: number) => run(() => suppressedAt(personId, new Date(instant)));
  assert.deepEqual(await at(now - 4 * HOUR_MS), allowed, "before its creation");
  assert.deepEqual(await at(created.getTime()), refused("never_contact_person"), "at its creation");
  assert.deepEqual(await at(now - 2 * HOUR_MS), refused("never_contact_person"), "while active");
  assert.deepEqual(await at(removed.getTime()), allowed, "removed by then");
  assert.deepEqual(await at(now), allowed);
  assert.deepEqual(await check(personId), allowed);
  await assert.rejects(
    run(() => suppressedAt(personId, new Date(Number.NaN))),
    {
      code: "contacts_input_invalid",
      details: { fields: ["at"] },
    },
  );
});

test("recordTouch never moves last_touch_at backward, nor the profile's updated_at; lastTouchAt reads it; an unknown person is person_not_found", async () => {
  const personId = await personAt("ines-touches");
  const updated = async () =>
    (await asRole("app").person.findFirstOrThrow({ where: { id: personId } })).updatedAt;
  const before = await updated();
  const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9));
  assert.equal(await run(() => lastTouchAt(personId)), null);
  const touches = [day(20), day(10), day(25)];
  const seen: (Date | null)[] = [];
  for (const at of touches) {
    await run(() => recordTouch(personId, at));
    seen.push(await run(() => lastTouchAt(personId)));
  }
  assert.deepEqual(seen, [day(20), day(20), day(25)]);
  assert.deepEqual(await updated(), before);
  const unknown = "per_00000000000000000000000000";
  const calls: (() => Promise<unknown>)[] = [
    () => recordTouch(unknown, day(1)),
    () => lastTouchAt(unknown),
  ];
  for (const call of calls) {
    await assert.rejects(run(call), { code: "person_not_found" });
  }
});

test("the same entry twice keeps one active row and publishes one contacts.suppression_added, with ids and the layer only; an opt-out beside it is a second entry", async () => {
  const personId = await personAt("ines-twice");
  const first = await block({ kind: "person", personId });
  const again = await block({ kind: "person", value: "https://linkedin.com/in/ines-twice" });
  assert.deepEqual([first.created, again.created], [true, false]);
  assert.deepEqual(again.entry, first.entry);
  const optOut = await run(() => addOptOut(personId, { source: "manual", createdBy: USER }));
  const optOutAgain = await run(() => addOptOut(personId, { source: "system" }));
  assert.deepEqual([optOut.created, optOutAgain.created], [true, false]);
  const app = asRole("app");
  assert.equal(await app.suppressionEntry.count({ where: { workspaceId: WORKSPACE } }), 2);
  const where = { workspaceId: WORKSPACE, eventName: "contacts.suppression_added" };
  const published = await app.outboxEntry.findMany({ where });
  const payloads = published.map((row) => row.payload as { layer: string });
  assert.deepEqual(
    payloads.sort((a, b) => a.layer.localeCompare(b.layer)),
    [
      { suppressionId: first.entry.id, layer: "blocklist" },
      { suppressionId: optOut.entry.id, layer: "opt_out" },
    ],
  );
});

test("an entry added a moment before a check is seen by that check: no cache", async () => {
  const personId = await personAt("ines-no-cache");
  assert.deepEqual(await check(personId), allowed);
  await block({ kind: "person", personId });
  assert.deepEqual(await check(personId), refused("never_contact_person"));
  // In one run too: the check reads what the run wrote.
  const other = await personAt("ines-same-run");
  const inRun = await run(async () => {
    const before = await suppressionOf(other, { newEnrollment: false });
    await addOptOut(other, { source: "system", reason: "reply_opt_out" });
    return [before, await suppressionOf(other, { newEnrollment: false })];
  });
  assert.deepEqual(inRun, [allowed, refused("opted_out")]);
});

test("erasePerson clears linkedin_url on the person's entries in both layers and keeps the hash; imported again, the person is still suppressed; a company's entry is unchanged", async () => {
  const personId = await personAt("ines-erased", { domain: "erased-co.example" });
  const { entry: blocked } = await block({ kind: "person", personId });
  await run(() => addOptOut(personId, { source: "system", reason: "reply_opt_out" }));
  const { entry: company } = await block({ kind: "company", value: "erased-co.example" });
  const app = asRole("app");
  const rows = () => app.suppressionEntry.findMany({ orderBy: { id: "asc" } });
  const before = await rows();

  await run(() => erasePerson(personId));
  const after = await rows();
  const own = after.filter((row) => row.matchType === "linkedin_url");
  assert.deepEqual(
    own.map((row) => [row.layer, row.linkedinUrl, row.hash]),
    [
      ["blocklist", null, blocked.hash],
      ["opt_out", null, before.find((row) => row.layer === "opt_out")?.hash],
    ],
  );
  assert.deepEqual(
    after.find((row) => row.id === company.id),
    before.find((row) => row.id === company.id),
  );
  assert.ok(!JSON.stringify(after).includes("ines-erased"), "no entry keeps the profile URL");

  // alpha's erased hash refuses a new import (person_erased); without it, the entries alone keep
  // the person suppressed, by the hash.
  await run(() =>
    assert.rejects(
      upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile: { linkedinUrl: "https://linkedin.com/in/ines-erased" },
      }),
      { code: "person_erased" },
    ),
  );
  await asRole("owner").personHash.deleteMany({ where: { kind: "erased" } });
  const again = await personAt("ines-erased");
  assert.deepEqual(await check(again), refused("opted_out"));
  assert.deepEqual(await run(() => suppressedAt(again, new Date())), refused("opted_out"));
});
