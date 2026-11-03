// contacts' commands end to end (alpha-p5-010) on the worktree's database, in this file's schema,
// each inside a tenant run as its callers make one. The routes' test is the api host's,
// core/apps/api/tests/contacts-persons.test.ts: a module never imports a host.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError, servicePrincipal } from "@whytide/platform";
import { fields } from "../domain/fields.ts";
import { isHashed, purgeExpiredHashes, recordHash } from "../domain/hashes.ts";
import {
  erasePerson,
  findPersonByLinkedinUrl,
  type Person,
  upsertPersonFromSource,
} from "../domain/persons.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: "wsp_contacts_test", principal }, fn, { client: asRole("app") });
const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const camel = (column: string) => column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const DAY = 86_400_000;
const profile = {
  linkedinUrl: "https://www.linkedin.com/in/ada-example-1?trk=public",
  providerId: "synthetic-member-1",
  firstName: "Ada",
  lastName: "Example",
  headline: "Builds data teams",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  locationText: "Berlin, Germany",
  fetchedAt: new Date("2026-10-01T08:00:00Z"),
};
const fromLinkedin = (person: typeof profile = profile) =>
  run(() => upsertPersonFromSource({ source: "linkedin", provider: "unipile", profile: person }));

test("one person for the same profile twice, its URL in another case with a trailing slash; every field has its provenance; a changed title keeps the newer value and its provenance", async () => {
  const first = await fromLinkedin();
  const linkedin = { source: "linkedin", provider: "unipile", at: "2026-10-01T08:00:00.000Z" };
  const values = first.person as unknown as Record<string, unknown>;
  for (const [column, pii] of Object.entries(fields.persons)) {
    if (pii === "none" || values[camel(column)] === null) continue;
    assert.deepEqual(first.person.fieldProvenance[camel(column)], linkedin, column);
  }
  assert.deepEqual([first.created, first.person.locationCountry], [true, "DE"]);

  const csv = { linkedinUrl: "HTTPS://LinkedIn.com/IN/Ada-Example-1/", title: "VP Data" };
  const fetchedAt = new Date("2026-10-02T08:00:00Z");
  const second = await run(() =>
    upsertPersonFromSource({ source: "import", provider: "csv", profile: { ...csv, fetchedAt } }),
  );
  const { person } = second;
  assert.deepEqual([second.created, person.id], [false, first.person.id]);
  assert.deepEqual([person.title, person.firstName], ["VP Data", "Ada"]);
  const imported = { source: "import", provider: "csv", at: "2026-10-02T08:00:00.000Z" };
  assert.deepEqual(person.fieldProvenance.title, imported);
  assert.deepEqual(person.fieldProvenance.firstName, linkedin);
  const rows = await asRole("app").person.findMany();
  assert.deepEqual(
    rows.map((row) => row.linkedinUrl),
    ["https://linkedin.com/in/ada-example-1"],
  );
});

test("erasePerson deletes the row and leaves an erased hash; isHashed knows it; a later upsert of the URL is person_erased", async () => {
  const { person } = await fromLinkedin();
  const variant = "linkedin.com/in/ADA-EXAMPLE-1/";
  assert.equal((await run(() => findPersonByLinkedinUrl(variant)))?.id, person.id);
  const erased = await run(() => erasePerson(person.id));
  assert.deepEqual(erased.counts, { review_decisions: 0, leads: 0, persons: 1 });
  assert.equal(await run(() => findPersonByLinkedinUrl(variant)), null);
  await assert.rejects(
    run(() => findPersonByLinkedinUrl("https://example.com/in/ada")),
    fails("linkedin_url_invalid"),
  );
  const app = asRole("app");
  assert.equal(await app.person.count(), 0);
  const hashes = await app.personHash.findMany();
  assert.deepEqual(
    hashes.map(({ kind, expiresAt }) => [kind, expiresAt]),
    [
      ["erased", null],
      ["erased", null],
    ],
    "one for the URL, one for the provider id",
  );
  assert.ok(hashes.every(({ hash }) => /^[0-9a-f]{64}$/.test(hash)));
  assert.ok(
    hashes.some(({ hash }) => hash === erased.hash),
    "the URL's hash is returned",
  );
  const urls = [variant, "https://linkedin.com/in/someone-else", "not a url"];
  assert.deepEqual([...(await run(() => isHashed({ linkedinUrls: urls })))], [[variant, "erased"]]);
  const providerIds = [profile.providerId];
  assert.deepEqual(
    [...(await run(() => isHashed({ providerIds })))],
    [[profile.providerId, "erased"]],
  );
  await assert.rejects(fromLinkedin(), fails("person_erased"));
  const { linkedinUrl: _, ...withAnotherUrl } = profile;
  const sameMember = { ...withAnotherUrl, linkedinUrl: "https://linkedin.com/in/ada-renamed" };
  await assert.rejects(fromLinkedin(sameMember), fails("person_erased"));
  assert.equal(await app.person.count(), 0);
  await assert.rejects(
    run(() => erasePerson(person.id)),
    fails("person_not_found"),
  );
});

test("a rejected candidate's hash expires after 90 days and purgeExpiredHashes removes it; an erased hash never expires", async () => {
  const rejected = { providerId: "synthetic-member-2", kind: "rejected_candidate" } as const;
  await run(() => recordHash({ ...rejected, dropReasons: ["hard_filter"] }));
  await run(() => recordHash({ ...rejected, dropReasons: ["hard_filter", "noise"] }));
  await run(() =>
    recordHash({ linkedinUrl: "https://linkedin.com/in/bao-sample", kind: "erased" }),
  );
  const app = asRole("app");
  const row = await app.personHash.findFirstOrThrow({ where: { kind: "rejected_candidate" } });
  assert.equal((row.expiresAt?.getTime() ?? 0) - row.createdAt.getTime(), 90 * DAY);
  assert.deepEqual(row.dropReasons, { hard_filter: 2, noise: 1 });
  assert.equal(await run(() => purgeExpiredHashes()), 0);

  // 91 days on: both rows as old as that, the rejected one past its expiry.
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  await app.personHash.updateMany({ data: { createdAt: ago(91) } });
  await app.personHash.update({ where: { id: row.id }, data: { expiresAt: ago(1) } });
  const providerIds = [rejected.providerId];
  assert.deepEqual([...(await run(() => isHashed({ providerIds })))], []);
  assert.equal(await run(() => purgeExpiredHashes()), 1);
  const left = await app.personHash.findMany();
  assert.deepEqual(
    left.map(({ kind, expiresAt }) => [kind, expiresAt]),
    [["erased", null]],
  );
  const expiring = app.personHash.updateMany({ data: { expiresAt: ago(-1) } });
  assert.equal(await sqlstate(expiring), "23514", "the CHECK refuses an erased hash an expiry");
});

test("a log line written with a person object has every person-data field redacted, through the field registry", async () => {
  const { person } = await fromLinkedin({
    ...profile,
    linkedinUrl: "https://linkedin.com/in/cara-fixture",
  });
  const logs = collectLogs();
  createLogger({ destination: logs.destination }).info({ person }, "contacts: a person");
  const [line] = logs.lines();
  const logged = line?.person as Record<keyof Person, unknown>;
  for (const [column, pii] of Object.entries(fields.persons)) {
    const value = logged[camel(column) as keyof Person];
    if (pii === "none") assert.notEqual(value, "[redacted]", column);
    else assert.equal(value, "[redacted]", column);
  }
  const text = JSON.stringify(line);
  for (const value of ["cara-fixture", "Ada", "Example", "Head of Data", "Blue Harbor", "Berlin"]) {
    assert.ok(!text.includes(value), value);
  }
});
