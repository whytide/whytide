// The safety cases of the never-contact list (beta-p2-010; docs/security.md "Suppression"), run by
// `pnpm -F contacts test:safety` and not by `test`: whoever is on the list, at a listed company or
// opted out is never answered "not suppressed", by the check before an action or by the list as it
// stood at an instant; an opt-out is never removed, by the command or by a direct write; removing a
// block leaves an opt-out in force; a person the check does not know is suppressed. Per channel
// (gamma-p2-040): an opt-out from every source stops every channel at the very next read, and holds
// every channel against a direct write; an entry on one channel stops that channel only. An exclusion
// list from a CSV (gamma-p2-045) stops its companies' people, their subdomains' included, on every
// channel at the next read, and no longer once the list is removed. review-gaps: removing a list
// keeps stopped a domain another active list names, a duplicate of it included, under that list and
// its relationship, and one a person added by hand onto the list's entry; the last list naming a
// domain lifts it. gamma-rf-040: an address blocked on every channel stops the person who holds it
// (recordPersonEmail) on every channel, and moves their lead, whichever came first; one blocked on
// email stops email only; an opt-out on an address is never removed. gamma-rf-050: a person known
// by an address alone, with no LinkedIn profile, is stopped on every channel by an entry on their
// address, one added by their id, their company's and an opt-out from every source, which lies on
// each of their addresses' hashes and is never removed.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../../domain/companies.ts";
import { recordPersonEmail } from "../../domain/emails.ts";
import { readExclusionFile } from "../../domain/exclusions/csv.ts";
import { importExclusionList, removeExclusionList } from "../../domain/exclusions/lists.ts";
import { createLeadForPerson } from "../../domain/leads.ts";
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

/** The reads with no channel, then on LinkedIn, then by email. */
const CHANNELS = [undefined, "linkedin", "email"] as const;
type Channel = (typeof CHANNELS)[number];
/** Every answer about the person on one channel, or with none: before an action, inside one, now. */
const answersOn = (personId: string, channel: Channel) =>
  run(async () => [
    await suppressionOf(personId, { newEnrollment: true, channel }),
    await suppressionOf(personId, { newEnrollment: false, channel }),
    await suppressedAt(personId, new Date(), { channel }),
  ]);
/** The three answers on each of CHANNELS, in its order. */
const everyRead = async (personId: string) => {
  const seen: unknown[] = [];
  for (const channel of CHANNELS) seen.push(...(await answersOn(personId, channel)));
  return seen;
};
/** A refusal as a read on `asked` answers it: with no channel, none; with one, the stop's channel. */
const stopped = (reason: string, asked: Channel, channel: string) =>
  asked === undefined ? suppressed(reason) : { ...suppressed(reason), channel };
const thrice = <T>(value: T) => [value, value, value];
const OPT_OUTS = [
  { source: "manual", createdBy: USER },
  { source: "system", reason: "reply_opt_out" },
  { source: "system", reason: "email_unsubscribe" },
  { source: "system", reason: "notice_opt_out" },
  { source: "system", reason: "complaint" },
] as const;

test("every opt-out source stops every channel at the very next read: by hand, reply_opt_out, email_unsubscribe, notice_opt_out and complaint, on linkedin, on email and with no channel", async () => {
  for (const [index, optOut] of OPT_OUTS.entries()) {
    const personId = await personAt(`safety-opt-out-source-${index}`);
    // The control: every read allows the person before the opt-out.
    assert.deepEqual(await everyRead(personId), thrice(thrice({ suppressed: false })).flat());
    await run(() => addOptOut(personId, optOut));
    // No clock moves: the read right after the opt-out stops every channel.
    const expected = CHANNELS.flatMap((asked) => thrice(stopped("opted_out", asked, "all")));
    assert.deepEqual(await everyRead(personId), expected, JSON.stringify(optOut));
  }
});

test("an entry on one channel stops that channel and the read with no channel, never the other channel: a person's and a company's, LinkedIn-only and email-only", async () => {
  const cases = [
    { channel: "linkedin", open: "email" },
    { channel: "email", open: "linkedin" },
  ] as const;
  for (const { channel, open } of cases) {
    const domain = `${channel}-only.example`;
    const person = await personAt(`safety-${channel}-only`);
    const colleague = await personAt(`safety-${channel}-only-colleague`, { domain });
    await run(async () => {
      await addSuppression({ kind: "person", personId: person, channel, createdBy: USER });
      await addSuppression({ kind: "company", value: domain, channel, createdBy: USER });
    });
    const stops = [
      [person, "never_contact_person"],
      [colleague, "never_contact_company"],
    ] as const;
    for (const [personId, reason] of stops) {
      const what = `${channel}-only ${reason}`;
      assert.deepEqual(await answersOn(personId, undefined), thrice(suppressed(reason)), what);
      const onIt = thrice(stopped(reason, channel, channel));
      assert.deepEqual(await answersOn(personId, channel), onIt, what);
      assert.deepEqual(await answersOn(personId, open), thrice({ suppressed: false }), what);
    }
  }
});

test("an opt-out holds every channel: the command refuses one on a single channel, and a direct write of its channel fails the CHECK", async () => {
  const personId = await personAt("safety-opt-out-every-channel");
  for (const channel of ["linkedin", "email"] as const) {
    const input = { kind: "person", personId, layer: "opt_out", channel, createdBy: USER } as const;
    await assert.rejects(
      run(() => addSuppression(input)),
      {
        code: "contacts_input_invalid",
        details: { fields: ["channel"] },
      },
    );
  }
  const { entry } = await run(() => addOptOut(personId, { source: "system", reason: "complaint" }));
  assert.equal(entry.channel, "all");
  for (const channel of ["linkedin", "email"]) {
    const write = asRole("app").$executeRaw`
      UPDATE suppression_entries SET channel = ${channel}::suppression_channel WHERE id = ${entry.id}`;
    assert.equal(await sqlstate(write), "23514", `check_violation: ${channel}`);
  }
  assert.deepEqual(await everyRead(personId), [
    ...CHANNELS.flatMap((asked) => thrice(stopped("opted_out", asked, "all"))),
  ]);
});

test("a person at a subdomain of an imported customer is stopped on every channel at the very next read, and no longer once the list is removed", async () => {
  const domain = "eu.imported-customer.example";
  const personId = await personAt("safety-imported-customer", { domain });
  const open = thrice(thrice({ suppressed: false })).flat();
  // The control: every read allows the person before the import.
  assert.deepEqual(await everyRead(personId), open);
  const csv = Readable.from([Buffer.from("Domain\r\nimported-customer.example\r\n")]);
  const file = await readExclusionFile(csv, { maxBytes: 1_024, maxRows: 10 });
  const input = { name: "customers.csv", relationship: "customer", createdBy: USER, file } as const;
  const { list, added } = await run(() => importExclusionList(input));
  assert.equal(added, 1);
  // No clock moves: the read right after the import stops every channel.
  const stops = CHANNELS.flatMap((asked) => thrice(stopped("never_contact_company", asked, "all")));
  assert.deepEqual(await everyRead(personId), stops);
  await run(() => removeExclusionList(list.id, { removedBy: USER }));
  assert.deepEqual(await everyRead(personId), open);
});

/** An exclusion list of the domains given, imported by USER as the relationship given. */
async function imported(relationship: "customer" | "competitor", ...domains: readonly string[]) {
  const csv = Readable.from([Buffer.from(["domain", ...domains].join("\r\n"))]);
  const file = await readExclusionFile(csv, { maxBytes: 1_024, maxRows: 10 });
  const input = { name: `${relationship}s.csv`, relationship, createdBy: USER, file };
  return run(() => importExclusionList(input));
}
/** Every read stops the person on every channel as at a listed company; or allows them. */
const companyStops = CHANNELS.flatMap((asked) =>
  thrice(stopped("never_contact_company", asked, "all")),
);
const allowed = thrice(thrice({ suppressed: false })).flat();
/** The workspace's active entries on the domain, as their list, relationship and source. */
const activeOn = async (domain: string) =>
  (
    await asRole("app").suppressionEntry.findMany({
      where: { workspaceId: "wsp_contacts_safety", domain, removedAt: null },
    })
  ).map(({ exclusionListId, relationship, source, createdBy }) => ({
    ...{ exclusionListId, relationship, source, createdBy },
  }));

test("a domain two lists name stays stopped on every channel until the last of them is removed: list A, then list B whose row of it is a duplicate; A removed, B holds it; B removed, it is lifted", async () => {
  const domain = "two-lists.example";
  const personId = await personAt("safety-two-lists", { domain: `eu.${domain}` });
  const a = await imported("customer", domain);
  const b = await imported("customer", "two-lists-other.example", domain);
  assert.deepEqual([a.added, b.added, b.duplicates], [1, 1, 1]);
  assert.deepEqual(await everyRead(personId), companyStops);
  await run(() => removeExclusionList(a.list.id, { removedBy: USER }));
  // No clock moves: the read right after the removal still stops every channel.
  assert.deepEqual(await everyRead(personId), companyStops, "B names it");
  await run(() => removeExclusionList(b.list.id, { removedBy: USER }));
  assert.deepEqual(await everyRead(personId), allowed, "no list names it");
  assert.deepEqual(await activeOn(domain), []);
});

test("a domain a person added by hand onto a list's entry stays stopped on every channel once the list is removed: the hand add takes the entry over, no list's any more", async () => {
  const domain = "hand-added.example";
  const personId = await personAt("safety-hand-added", { domain });
  const { list } = await imported("customer", domain);
  const byHand = { kind: "company", value: domain, relationship: "customer" } as const;
  const added = await run(() => addSuppression({ ...byHand, createdBy: "usr_by_hand" }));
  assert.equal(added.created, false);
  const takenOver = { exclusionListId: null, relationship: "customer", source: "manual" };
  assert.deepEqual(await activeOn(domain), [{ ...takenOver, createdBy: "usr_by_hand" }]);
  await run(() => removeExclusionList(list.id, { removedBy: USER }));
  assert.deepEqual(await everyRead(personId), companyStops);
  assert.deepEqual(await activeOn(domain), [{ ...takenOver, createdBy: "usr_by_hand" }]);
});

test("the only list naming a domain removed: the domain is lifted on every channel", async () => {
  const domain = "only-list.example";
  const personId = await personAt("safety-only-list", { domain });
  const { list } = await imported("competitor", domain);
  assert.deepEqual(await everyRead(personId), companyStops);
  await run(() => removeExclusionList(list.id, { removedBy: USER }));
  assert.deepEqual(await everyRead(personId), allowed);
});

test("a customer on list A, a competitor on lists B then C: after A's removal the entry is the earliest other list's, B's, with B's relationship, and the domain stays stopped", async () => {
  const domain = "customer-then-competitor.example";
  const personId = await personAt("safety-customer-competitor", { domain });
  const a = await imported("customer", domain);
  const b = await imported("competitor", domain);
  await imported("customer", domain);
  await run(() => removeExclusionList(a.list.id, { removedBy: USER }));
  const moved = { exclusionListId: b.list.id, relationship: "competitor", source: "csv" };
  assert.deepEqual(await activeOn(domain), [{ ...moved, createdBy: USER }]);
  assert.deepEqual(await everyRead(personId), companyStops);
});

/** A person of the workspace with a lead, imported. */
async function leadAt(slug: string) {
  const personId = await personAt(slug);
  const source = { kind: "imported", ref: "imp_safety" } as const;
  await run(() => createLeadForPerson({ personId, source }));
  return personId;
}
const statusOf = async (personId: string) =>
  (await asRole("app").lead.findFirstOrThrow({ where: { personId } })).outreachStatus;
/** The address's hash recorded for the person, as enrichment does before it keeps the address. */
const holds = (personId: string, address: string) =>
  run(() => recordPersonEmail({ personId, address }));

test("an address blocked on every channel stops the person who holds it on every channel at the very next read, and their lead is suppressed: recorded before the entry or after it, whatever its case and spaces, among the person's other addresses", async () => {
  const before = await leadAt("safety-address-before");
  const after = await leadAt("safety-address-after");
  assert.deepEqual(await holds(before, "noor@clear.example"), {
    holder: "self",
    suppressed: false,
  });
  assert.deepEqual(await holds(before, "noor.before@blocked.example"), {
    holder: "self",
    suppressed: false,
  });
  // The control: every read allows the person before the entry.
  assert.deepEqual(await everyRead(before), allowed);
  await run(async () => {
    const value = " Noor.Before@Blocked.EXAMPLE ";
    await addSuppression({ kind: "person", value, createdBy: USER });
    await addSuppression({ kind: "person", value: "noor.after@blocked.example", createdBy: USER });
  });
  // The entry first, the address later: recorded, and answered suppressed.
  assert.deepEqual(await holds(after, "NOOR.AFTER@blocked.example"), {
    holder: "self",
    suppressed: true,
  });
  const stops = CHANNELS.flatMap((asked) => thrice(stopped("never_contact_person", asked, "all")));
  for (const personId of [before, after]) {
    // No clock moves: the read right after the entry, or the record, stops every channel.
    assert.deepEqual(await everyRead(personId), stops, personId);
    assert.equal(await statusOf(personId), "suppressed", personId);
  }
});

test("an address blocked on email only stops the email read and the read with no channel, never linkedin, and moves no lead: recorded before the entry or after it", async () => {
  const before = await leadAt("safety-address-email-before");
  const after = await leadAt("safety-address-email-after");
  await holds(before, "noor.email-before@example.com");
  const status = await statusOf(before);
  await run(async () => {
    for (const value of ["noor.email-before@example.com", "noor.email-after@example.com"]) {
      await addSuppression({ kind: "person", value, channel: "email", createdBy: USER });
    }
  });
  assert.deepEqual(await holds(after, "noor.email-after@example.com"), {
    holder: "self",
    suppressed: true,
  });
  for (const personId of [before, after]) {
    const reason = "never_contact_person";
    assert.deepEqual(await answersOn(personId, undefined), thrice(suppressed(reason)), personId);
    const onEmail = thrice(stopped(reason, "email", "email"));
    assert.deepEqual(await answersOn(personId, "email"), onEmail, personId);
    assert.deepEqual(
      await answersOn(personId, "linkedin"),
      thrice({ suppressed: false }),
      personId,
    );
    assert.equal(await statusOf(personId), status, personId);
  }
});

test("an opt-out on an address answers opted_out on every channel and is never removed: the command refuses it, and a direct write of removed_at fails the CHECK", async () => {
  const personId = await leadAt("safety-address-opt-out");
  await holds(personId, "noor.opt-out@example.com");
  const optOut = { kind: "person", value: "noor.opt-out@example.com", layer: "opt_out" } as const;
  const { entry } = await run(() => addSuppression({ ...optOut, createdBy: USER }));
  assert.deepEqual([entry.matchType, entry.channel], ["email", "all"]);
  await assert.rejects(
    run(() => removeSuppression(entry.id, { removedBy: USER })),
    {
      code: "suppression_not_removable",
    },
  );
  const write = asRole("app").$executeRaw`
    UPDATE suppression_entries SET removed_at = now(), removed_by = ${USER} WHERE id = ${entry.id}`;
  assert.equal(await sqlstate(write), "23514", "check_violation");
  const expected = CHANNELS.flatMap((asked) => thrice(stopped("opted_out", asked, "all")));
  assert.deepEqual(await everyRead(personId), expected);
  assert.equal(await statusOf(personId), "suppressed");
});

/**
 * A person known by an email address alone, with no LinkedIn profile (gamma-rf-050), at the company
 * with that domain when one is given, with a lead.
 */
async function addressOnlyLeadAt(address: string, company?: { domain: string }) {
  return run(async () => {
    const profile = { email: address, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    assert.equal(person.linkedinUrl, null);
    if (company !== undefined) {
      const name = `Company of ${address}`;
      const { company: row } = await upsertCompany({
        source: "import",
        provider: "csv",
        company: { name, ...company },
      });
      await linkPersonToCompany({ personId: person.id, companyId: row.id });
    }
    const source = { kind: "imported", ref: "imp_safety" } as const;
    await createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
}
/** Every read stops the person on every channel, for the reason. */
const everywhere = (reason: string) =>
  CHANNELS.flatMap((asked) => thrice(stopped(reason, asked, "all")));

test("a person without a LinkedIn profile is stopped on every channel at the very next read, their lead suppressed: by an entry on their address, one added by their id, and their company's", async () => {
  const byValue = await addressOnlyLeadAt("noor.by-value@nolink.example");
  const byId = await addressOnlyLeadAt("noor.by-id@nolink.example");
  const domain = "blocked-nolink.example";
  const atCompany = await addressOnlyLeadAt("noor.at-company@nolink.example", { domain });
  // The control: every read allows each of them before the entries.
  for (const personId of [byValue, byId, atCompany]) {
    assert.deepEqual(await everyRead(personId), allowed, personId);
  }
  await run(async () => {
    const value = " Noor.By-Value@NoLink.example ";
    await addSuppression({ kind: "person", value, createdBy: USER });
    await addSuppression({ kind: "person", personId: byId, createdBy: USER });
    await addSuppression({ kind: "company", value: domain, createdBy: USER });
  });
  // No clock moves: the read right after the entries stops every channel.
  assert.deepEqual(await everyRead(byValue), everywhere("never_contact_person"), "by value");
  assert.deepEqual(await everyRead(byId), everywhere("never_contact_person"), "by id");
  assert.deepEqual(await everyRead(atCompany), everywhere("never_contact_company"), "company");
  for (const personId of [byValue, byId, atCompany]) {
    assert.equal(await statusOf(personId), "suppressed", personId);
  }
});

test("every opt-out source stops a person without a LinkedIn profile on every channel at the very next read, on each of their addresses' hashes, and the opt-out is never removed", async () => {
  const app = asRole("app");
  for (const [index, optOut] of OPT_OUTS.entries()) {
    const personId = await addressOnlyLeadAt(`noor.opt-out-${index}@nolink.example`);
    await holds(personId, `noor.opt-out-${index}.home@nolink.example`);
    // The control: every read allows the person before the opt-out.
    assert.deepEqual(await everyRead(personId), allowed);
    const { entry } = await run(() => addOptOut(personId, optOut));
    assert.deepEqual([entry.matchType, entry.email, entry.channel], ["email", null, "all"]);
    // No clock moves: the read right after the opt-out stops every channel.
    assert.deepEqual(await everyRead(personId), everywhere("opted_out"), JSON.stringify(optOut));
    assert.equal(await statusOf(personId), "suppressed");
    const hashes = (await app.personEmailHash.findMany({ where: { personId } })).map(
      ({ hash }) => hash,
    );
    const entries = await app.suppressionEntry.findMany({
      where: { layer: "opt_out", hash: { in: hashes }, removedAt: null },
    });
    assert.deepEqual(entries.map(({ hash }) => hash).sort(), [...hashes].sort(), "every address");
    for (const { id } of entries) {
      await assert.rejects(
        run(() => removeSuppression(id, { removedBy: USER })),
        {
          code: "suppression_not_removable",
        },
      );
    }
    assert.deepEqual(await everyRead(personId), everywhere("opted_out"));
  }
});
