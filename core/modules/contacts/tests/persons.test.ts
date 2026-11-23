// contacts' commands end to end (alpha-p5-010) on the worktree's database, in this file's schema,
// each inside a tenant run as its callers make one. The routes' test is the api host's,
// core/apps/api/tests/contacts-persons.test.ts: a module never imports a host.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger, isAppError, servicePrincipal } from "@whytide/platform";
import { recordPersonEmail } from "../domain/emails.ts";
import { fields } from "../domain/fields.ts";
import { isHashed, purgeExpiredHashes, recordHash } from "../domain/hashes.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import {
  erasePerson,
  findPersonByEmail,
  findPersonByLinkedinUrl,
  type LockedPerson,
  type Person,
  upsertPersonFromSource,
} from "../domain/persons.ts";
import { suppressionOf } from "../domain/suppression/checks.ts";
import { addOptOut, addSuppression } from "../domain/suppression/entries.ts";
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
  const counts = { person_email_hashes: 0, review_decisions: 0, leads: 0, persons: 1 };
  assert.deepEqual(erased.counts, counts);
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

test("erasePerson with writeErasedHash false deletes the same rows and empties the same entry URLs, and writes and answers no hash; the URL comes back as a new person", async () => {
  /** The fixture's profile with a URL and a member id of its own. */
  const own = (slug: string) => ({
    ...profile,
    linkedinUrl: `https://linkedin.com/in/${slug}`,
    providerId: `synthetic-${slug}`,
  });
  /** A person with a lead and an opt-out on its profile; its erasure, then what is left of it. */
  const erased = async (slug: string, options?: { writeErasedHash: boolean }) => {
    const { person } = await fromLinkedin(own(slug));
    await run(async () => {
      await createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      await addOptOut(person.id, { source: "manual", createdBy: "usr_1" });
    });
    const erasure = await run(() => erasePerson(person.id, options));
    const app = asRole("app");
    const left = await Promise.all([
      app.person.count({ where: { id: person.id } }),
      app.lead.count({ where: { personId: person.id } }),
      app.leadStatusChange.count({ where: { personId: person.id } }),
      app.suppressionEntry.count({ where: { linkedinUrl: { contains: slug } } }),
    ]);
    return { erasure, left, person };
  };
  const kept = await erased("kept-hash-1");
  const app = asRole("app");
  const hashes = await app.personHash.count();
  assert.equal(hashes, 2, "the default writes the URL's and the provider id's");
  const job = await erased("no-hash-1", { writeErasedHash: false });
  assert.deepEqual(job.erasure.counts, kept.erasure.counts);
  assert.deepEqual(job.left, [0, 0, 0, 0]);
  assert.deepEqual(kept.left, [0, 0, 0, 0]);
  assert.equal(job.erasure.hash, null);
  assert.equal(await app.personHash.count(), hashes, "no hash written");
  // Both entries stay, without their URL; nothing stops the person coming back as a new one, whom
  // the entry still suppresses.
  assert.equal(await app.suppressionEntry.count({ where: { linkedinUrl: null } }), 2);
  const again = await fromLinkedin(own("no-hash-1"));
  assert.deepEqual([again.created, again.person.id === job.person.id], [true, false]);
  const check = await run(() => suppressionOf(again.person.id, { newEnrollment: true }));
  assert.equal(check.suppressed, true);
});

test("erasePerson deletes the person's address hashes, counted; an entry on an address keeps its hash and loses the address; the address hash is erased, so another person is other_person on it; without it, another person may hold the address and the entry stops them", async () => {
  /** The fixture's profile with a URL and a member id of its own. */
  const own = (slug: string) => ({
    ...profile,
    linkedinUrl: `https://linkedin.com/in/${slug}`,
    providerId: `synthetic-${slug}`,
  });
  const record = (personId: string, address: string) =>
    run(() => recordPersonEmail({ personId, address }));
  /** A person holding two addresses, the first blocked; its erasure. */
  const erased = async (slug: string, options?: { writeErasedHash: boolean }) => {
    const { person } = await fromLinkedin(own(slug));
    await record(person.id, `${slug}@harbor.example`);
    await record(person.id, `${slug}.home@harbor.example`);
    const value = `${slug}@harbor.example`;
    await run(() => addSuppression({ kind: "person", value, createdBy: "usr_1" }));
    return { erasure: await run(() => erasePerson(person.id, options)), person };
  };
  const app = asRole("app");
  const kept = await erased("ada-address-1");
  const counts = { person_email_hashes: 2, review_decisions: 0, leads: 0, persons: 1 };
  assert.deepEqual(kept.erasure.counts, counts);
  assert.equal(await app.personEmailHash.count({ where: { personId: kept.person.id } }), 0);
  const entries = await app.suppressionEntry.findMany({ where: { matchType: "email" } });
  assert.deepEqual(
    entries.map(({ email, hash }) => [email, /^[0-9a-f]{64}$/.test(hash)]),
    [[null, true]],
  );
  assert.equal(await app.personHash.count({ where: { kind: "erased" } }), 4, "URL, id, addresses");
  const { person: next } = await fromLinkedin(own("ada-next-1"));
  assert.deepEqual(await record(next.id, "ADA-ADDRESS-1@harbor.example"), {
    holder: "other_person",
    suppressed: true,
  });
  assert.deepEqual(await record(next.id, "ada-address-1.home@harbor.example"), {
    holder: "other_person",
    suppressed: false,
  });
  assert.equal(await app.personEmailHash.count({ where: { personId: next.id } }), 0);
  // Privacy's 30-day rule: no erased hash, so a later person may hold the address; the entry, by its
  // hash, stops them.
  const job = await erased("ada-address-2", { writeErasedHash: false });
  assert.deepEqual(job.erasure.counts, counts);
  const { person: later } = await fromLinkedin(own("ada-later-2"));
  assert.deepEqual(await record(later.id, "ada-address-2@harbor.example"), {
    holder: "self",
    suppressed: true,
  });
  assert.deepEqual(await run(() => suppressionOf(later.id, { newEnrollment: true })), {
    suppressed: true,
    reason: "never_contact_person",
  });
});

test("erasePerson's beforeDelete reads the person's row under its lock right before the delete; what it throws keeps every row", async () => {
  const slug = "ada-locked-1";
  const own = { ...profile, linkedinUrl: `https://linkedin.com/in/${slug}`, providerId: slug };
  const { person } = await fromLinkedin(own);
  const source = { kind: "imported", ref: "imp_1" } as const;
  await run(() => createLeadForPerson({ personId: person.id, source }));
  // Another transaction may not take the row: SKIP LOCKED skips it while the erasure holds it.
  const locked = async () => {
    const free = await asRole("owner").$queryRaw<unknown[]>`
      SELECT 1 FROM persons WHERE id = ${person.id} FOR UPDATE SKIP LOCKED`;
    return free.length === 0 ? "locked" : "free";
  };
  const app = asRole("app");
  const left = () =>
    Promise.all([
      app.person.count({ where: { id: person.id } }),
      app.lead.count({ where: { personId: person.id } }),
    ]);
  const seen: string[] = [];
  const kept = new Error("kept by the caller");
  const beforeDelete = async ({ createdAt, lastTouchAt, locationCountry }: LockedPerson) => {
    seen.push(
      `${createdAt instanceof Date}, ${lastTouchAt}, ${locationCountry}, ${await locked()}`,
    );
    throw kept;
  };
  const refused = run(() => erasePerson(person.id, { writeErasedHash: false, beforeDelete }));
  await assert.rejects(refused, (error) => error === kept);
  assert.deepEqual(seen, ["true, null, DE, locked"]);
  assert.deepEqual(await left(), [1, 1], "the lead's delete rolled back with the rest");
  const goes = async () => {};
  const erasure = await run(() => erasePerson(person.id, { beforeDelete: goes }));
  assert.equal(erasure.counts.persons, 1);
  assert.deepEqual(await left(), [0, 0]);
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

test("the migration contacts_title_hashes_reset (title-check-ai) deletes the rejected candidates' hashes whose only reason is title_mismatch and keeps a country's, a title's beside a country's, one without reasons and an erased one; run again, it deletes none", async () => {
  const migrations = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  const folder = readdirSync(migrations).find((name) =>
    name.endsWith("_contacts_title_hashes_reset"),
  );
  assert.ok(folder, "the migration's folder");
  const sql = readFileSync(new URL(`${folder}/migration.sql`, migrations), "utf8");
  const reasons: Record<string, string[]> = {
    title: ["title_mismatch"],
    twice: ["title_mismatch"],
    country: ["country_mismatch"],
    both: ["title_mismatch", "country_mismatch"],
    none: [],
  };
  for (const [slug, dropReasons] of Object.entries(reasons)) {
    const providerId = `hash-${slug}`;
    await run(() => recordHash({ providerId, kind: "rejected_candidate", dropReasons }));
  }
  const twice = { providerId: "hash-twice", kind: "rejected_candidate" } as const;
  await run(() => recordHash({ ...twice, dropReasons: ["title_mismatch"] }));
  const erased = "https://linkedin.com/in/hash-erased";
  await run(() => recordHash({ linkedinUrl: erased, kind: "erased" }));

  const owner = asRole("owner");
  assert.equal(await owner.$executeRawUnsafe(sql), 2);
  const providerIds = Object.keys(reasons).map((slug) => `hash-${slug}`);
  const left = await run(() => isHashed({ providerIds }));
  assert.deepEqual([...left.keys()].sort(), ["hash-both", "hash-country", "hash-none"]);
  const kept = await run(() => isHashed({ linkedinUrls: [erased] }));
  assert.equal(kept.get(erased), "erased");
  assert.equal(await owner.$executeRawUnsafe(sql), 0);
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

/** An upsert by an email address, with the profile's fields given (gamma-rf-050). */
const byEmail = (email: string, fields: Record<string, string> = {}) =>
  run(() =>
    upsertPersonFromSource({ source: "import", provider: "csv", profile: { email, ...fields } }),
  );
/** The workspace's persons and address hashes as stored, to compare before and after a refusal. */
const stored = async () => {
  const app = asRole("app");
  return [
    await app.person.findMany({ orderBy: { id: "asc" } }),
    await app.personEmailHash.findMany({ orderBy: { hash: "asc" } }),
  ];
};

test("a person known by an email address alone: created with no URL and the address's hash, never the address; found again by it, in another case; given a URL with it, they take it, and the URL alone finds them", async () => {
  const app = asRole("app");
  const first = await byEmail("noor.address-only@harbor.example", { firstName: "Noor" });
  assert.deepEqual([first.created, first.person.linkedinUrl], [true, null]);
  const hashes = await app.personEmailHash.findMany({ where: { personId: first.person.id } });
  assert.deepEqual(
    hashes.map(({ hash }) => /^[0-9a-f]{64}$/.test(hash)),
    [true],
  );
  const text = JSON.stringify(await app.person.findMany());
  assert.ok(!text.includes("noor.address-only"), "no column holds the address");
  const found = await run(() => findPersonByEmail(" Noor.Address-Only@Harbor.EXAMPLE "));
  assert.equal(found?.id, first.person.id);

  const again = await byEmail("NOOR.ADDRESS-ONLY@harbor.example", { lastName: "Example" });
  assert.deepEqual([again.created, again.person.id], [false, first.person.id]);
  assert.deepEqual([again.person.firstName, again.person.lastName], ["Noor", "Example"]);
  const url = "https://www.linkedin.com/in/Noor-Address-Only/";
  const withUrl = await run(() =>
    upsertPersonFromSource({
      source: "linkedin",
      provider: "unipile",
      profile: { linkedinUrl: url, email: "noor.address-only@harbor.example" },
    }),
  );
  assert.deepEqual(
    [withUrl.created, withUrl.person.id, withUrl.person.linkedinUrl],
    [false, first.person.id, "https://linkedin.com/in/noor-address-only"],
  );
  assert.equal(withUrl.person.fieldProvenance.linkedinUrl?.source, "linkedin");
  const byUrl = await run(() =>
    upsertPersonFromSource({
      source: "import",
      provider: "csv",
      profile: { linkedinUrl: "linkedin.com/in/noor-address-only", headline: "Builds data teams" },
    }),
  );
  assert.deepEqual([byUrl.created, byUrl.person.id], [false, first.person.id]);
  const variant = "https://linkedin.com/in/NOOR-ADDRESS-ONLY";
  assert.equal((await run(() => findPersonByLinkedinUrl(variant)))?.id, first.person.id);
  // A person found by the URL takes an address they lack, as its hash.
  const { person: ada } = await fromLinkedin();
  const withAddress = await run(() =>
    upsertPersonFromSource({
      source: "import",
      provider: "csv",
      profile: { linkedinUrl: profile.linkedinUrl, email: "ada@harbor.example" },
    }),
  );
  assert.deepEqual([withAddress.created, withAddress.person.id], [false, ada.id]);
  assert.equal((await run(() => findPersonByEmail("ada@harbor.example")))?.id, ada.id);
  assert.equal(await app.person.count(), 2);
  assert.equal(await app.personEmailHash.count(), 2);
});

test("an upsert's keys: neither a URL nor an address, or a text that is no address, is contacts_input_invalid naming them; findPersonByEmail answers null for an address nobody holds", async () => {
  const neither = { source: "import", provider: "csv", profile: { firstName: "Nobody" } };
  await assert.rejects(
    run(() => upsertPersonFromSource(neither as never)),
    {
      code: "contacts_input_invalid",
      details: { fields: ["profile.linkedinUrl", "profile.email"] },
    },
  );
  await assert.rejects(byEmail("not an address"), {
    code: "contacts_input_invalid",
    details: { fields: ["profile.email"] },
  });
  await assert.rejects(
    run(() => findPersonByEmail("not an address")),
    {
      code: "contacts_input_invalid",
      details: { fields: ["address"] },
    },
  );
  assert.equal(await run(() => findPersonByEmail("nobody@harbor.example")), null);
  assert.deepEqual(await stored(), [[], []]);
});

test("person_conflict changes no row: a URL and an address of two persons, or the address of a person with another URL", async () => {
  const { person: ada } = await fromLinkedin();
  await byEmail("noor.conflict@harbor.example", { firstName: "Noor" });
  const bea = await run(() =>
    upsertPersonFromSource({
      source: "import",
      provider: "csv",
      profile: { linkedinUrl: "https://linkedin.com/in/bea-conflict", email: "bea@harbor.example" },
    }),
  );
  assert.equal(bea.created, true);
  const before = await stored();
  const conflicts = [
    { linkedinUrl: profile.linkedinUrl, email: "noor.conflict@harbor.example" },
    { linkedinUrl: "https://linkedin.com/in/bea-renamed", email: "bea@harbor.example" },
    { linkedinUrl: profile.linkedinUrl, email: "BEA@harbor.example", title: "CTO" },
  ];
  for (const keys of conflicts) {
    await assert.rejects(
      run(() => upsertPersonFromSource({ source: "linkedin", provider: "unipile", profile: keys })),
      fails("person_conflict"),
      JSON.stringify(keys),
    );
  }
  assert.deepEqual(await stored(), before);
  assert.equal((await run(() => findPersonByEmail("bea@harbor.example")))?.id, bea.person.id);
  assert.notEqual(ada.id, bea.person.id);
});

test("erasePerson of a person without a profile writes their addresses' erased hashes and answers the first recorded; an upsert with an address an erased person held, alone or beside a URL, or with the URL they had, is person_erased and writes nothing", async () => {
  const app = asRole("app");
  const { person } = await byEmail("noor.erased@harbor.example", { firstName: "Noor" });
  await run(() =>
    recordPersonEmail({ personId: person.id, address: "noor.erased.home@harbor.example" }),
  );
  const [first] = await app.personEmailHash.findMany({
    where: { personId: person.id },
    orderBy: [{ createdAt: "asc" }, { hash: "asc" }],
  });
  const erasure = await run(() => erasePerson(person.id));
  const counts = { person_email_hashes: 2, review_decisions: 0, leads: 0, persons: 1 };
  assert.deepEqual([erasure.counts, erasure.hash], [counts, first?.hash]);
  assert.equal(await app.personHash.count({ where: { kind: "erased" } }), 2, "the two addresses");
  for (const email of ["NOOR.ERASED@harbor.example", "noor.erased.home@harbor.example"]) {
    await assert.rejects(byEmail(email), fails("person_erased"), email);
  }
  // A person with a profile and an address, erased: the address, the URL, each is refused.
  const { person: ada } = await fromLinkedin();
  await run(() => recordPersonEmail({ personId: ada.id, address: "ada.erased@harbor.example" }));
  const withProfile = await run(() => erasePerson(ada.id));
  const urlHash = (await app.personHash.findMany()).map(({ hash }) => hash);
  assert.ok(urlHash.includes(withProfile.hash ?? ""), "the URL's hash is answered");
  const refused = [
    { email: "ada.erased@harbor.example" },
    { linkedinUrl: profile.linkedinUrl },
    { linkedinUrl: "https://linkedin.com/in/ada-new", email: "ada.erased@harbor.example" },
  ] as const;
  for (const keys of refused) {
    await assert.rejects(
      run(() => upsertPersonFromSource({ source: "import", provider: "csv", profile: keys })),
      fails("person_erased"),
      JSON.stringify(keys),
    );
  }
  assert.deepEqual(await stored(), [[], []]);
  // Privacy's 30-day rule: no erased hash, so the address may come back, as a new person.
  const { person: later } = await byEmail("noor.later@harbor.example");
  const job = await run(() => erasePerson(later.id, { writeErasedHash: false }));
  assert.equal(job.hash, null);
  assert.equal((await byEmail("noor.later@harbor.example")).created, true);
});
