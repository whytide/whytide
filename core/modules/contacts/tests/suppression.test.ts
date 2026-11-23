// contacts' never-contact list end to end (beta-p2-010) on the worktree's database, in this file's
// schema, each command inside a tenant run as its callers make one: the matching, the order of the
// reasons, the 90-day rule, the list as it stood at an instant, the touches, the event, no cache,
// and what erasure keeps; per channel (gamma-p2-040), the channel reads, the relationship entries,
// the CHECKs, the lead moves, the batch with its query count, and suppressedAt on a channel. An email
// address (gamma-rf-040): an entry by value, the list's holder, recordPersonEmail's answers, and
// suppressedAt by the addresses recorded by then. A person without a LinkedIn profile (gamma-rf-050):
// the check by their addresses and company, their entries on their addresses' hashes, the list's
// names, and the entries erasure keeps. The safety cases are
// tests/safety/suppression.test.ts; the routes' test is the api host's,
// core/apps/api/tests/contacts-suppression.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { type PrismaClient, withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { parseEventPayload, servicePrincipal } from "@whytide/platform";
import { upsertPersonsFromSource } from "../domain/batch.ts";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { recordPersonEmail } from "../domain/emails.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { erasePerson, upsertPersonFromSource } from "../domain/persons.ts";
import {
  lastTouchAt,
  recordTouch,
  suppressedAt,
  suppressionOf,
  suppressionsOf,
} from "../domain/suppression/checks.ts";
import {
  DAY_MS,
  SUPPRESSION_BATCH_SIZE,
  type SuppressionChannel,
} from "../domain/suppression/constants.ts";
import {
  addOptOut,
  addSuppression,
  listSuppression,
  removeSuppression,
} from "../domain/suppression/entries.ts";
import { events } from "../events.ts";
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

test("the same entry twice keeps one active row and publishes one contacts.suppression_added, with ids, the layer and the channel only; an opt-out beside it is a second entry", async () => {
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
      { suppressionId: first.entry.id, layer: "blocklist", channel: "all" },
      { suppressionId: optOut.entry.id, layer: "opt_out", channel: "all" },
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

/** A person of the workspace with a lead, at a company with the domain given; its id. */
async function leadAt(slug: string, company?: { domain?: string; linkedinUrl?: string }) {
  const personId = await personAt(slug, company);
  const source = { kind: "imported", ref: "imp_suppression" } as const;
  await run(() => createLeadForPerson({ personId, source }));
  return personId;
}
const leadOf = (personId: string) => asRole("app").lead.findFirstOrThrow({ where: { personId } });
/** The answer of a read on `channel`, or of one with none. */
const on = (personId: string, channel?: SuppressionChannel, newEnrollment = true) =>
  run(() => suppressionOf(personId, { newEnrollment, channel }));
/** A refusal as a read on a channel answers it: with the channel that decided. */
const refusedOn = (reason: string, channel: SuppressionChannel) => ({
  ...refused(reason),
  channel,
});
const READS = [undefined, "all", "linkedin", "email"] as const;

test("a read on a channel counts the entries on it and on every channel and names the channel that decided; the stops on every channel and the last touch come first; `all` counts only the stops on every channel; a channel off the list is contacts_input_invalid", async () => {
  const both = await personAt("ines-both-channels", { domain: "both.example" });
  const touched = await personAt("ines-linkedin-touched");
  await block({ kind: "person", personId: both, channel: "linkedin" });
  await block({ kind: "company", value: "both.example" });
  await block({ kind: "person", personId: touched, channel: "linkedin" });
  await run(() => recordTouch(touched, new Date(Date.now() - DAY_MS)));

  // The company's entry on every channel decides before the person's on LinkedIn.
  assert.deepEqual(await on(both, "linkedin"), refusedOn("never_contact_company", "all"));
  assert.deepEqual(await on(both, "email"), refusedOn("never_contact_company", "all"));
  assert.deepEqual(await on(both), refused("never_contact_company"));
  // The last touch, for a new enrollment, decides before an entry on one channel.
  assert.deepEqual(await on(touched, "linkedin"), refusedOn("recently_contacted", "all"));
  assert.deepEqual(
    await on(touched, "linkedin", false),
    refusedOn("never_contact_person", "linkedin"),
  );
  assert.deepEqual(await on(touched, undefined, false), refused("never_contact_person"));
  assert.deepEqual(await on(touched, "email", false), allowed);
  assert.deepEqual(await on(touched, "all", false), allowed);
  const unknown = "per_00000000000000000000000000";
  assert.deepEqual(await on(unknown, "email"), refusedOn("person_not_found", "all"));
  const invalid = { code: "contacts_input_invalid", details: { fields: ["channel"] } };
  for (const channel of ["sms", "", "ALL", null]) {
    const options = { newEnrollment: true, channel: channel as unknown as SuppressionChannel };
    await assert.rejects(
      run(() => suppressionOf(both, options)),
      invalid,
      String(channel),
    );
    await assert.rejects(
      run(() => suppressionsOf([both], options)),
      invalid,
      String(channel),
    );
    await assert.rejects(
      run(() => suppressedAt(both, new Date(), options)),
      invalid,
    );
  }
});

test("a customer or a competitor excluded by its domain is a relationship entry: its people and its subdomains' are never_contact_company on every channel and their leads suppressed; lifted, it stops no one", async () => {
  const atRival = await leadAt("ines-rival", { domain: "rival.example" });
  const atRivalSub = await leadAt("ines-eu-rival", { domain: "eu.rival.example" });
  const atClient = await leadAt("ines-client", { domain: "client.example" });
  const lookalike = await leadAt("ines-notrival", { domain: "notrival.example" });
  const client = await run(async () => {
    const company = { name: "Client Co", domain: "client.example" };
    return (await upsertCompany({ source: "import", provider: "csv", company })).company;
  });
  const rival = await block({
    kind: "company",
    value: "https://www.rival.example/about",
    relationship: "competitor",
  });
  const customer = await block({ kind: "company", companyId: client.id, relationship: "customer" });
  const shape = ({ entry }: { entry: Record<string, unknown> }) => [
    entry.layer,
    entry.relationship,
    entry.matchType,
    entry.domain,
    entry.channel,
    entry.source,
  ];
  assert.deepEqual(
    [shape(rival), shape(customer)],
    [
      ["relationship", "competitor", "domain", "rival.example", "all", "manual"],
      ["relationship", "customer", "domain", "client.example", "all", "manual"],
    ],
  );
  for (const personId of [atRival, atRivalSub, atClient]) {
    for (const channel of READS) {
      const expected =
        channel === undefined
          ? refused("never_contact_company")
          : refusedOn("never_contact_company", "all");
      assert.deepEqual(await on(personId, channel, false), expected, `${personId} ${channel}`);
    }
    const lead = await leadOf(personId);
    assert.deepEqual(
      [lead.outreachStatus, lead.outreachReason],
      ["suppressed", "never_contact_company"],
    );
  }
  assert.deepEqual(await on(lookalike), allowed, "notrival.example is no subdomain");
  assert.equal((await leadOf(lookalike)).outreachStatus, "pending_review");

  await run(() => removeSuppression(rival.entry.id, { removedBy: USER }));
  assert.deepEqual([await on(atRival), await on(atRivalSub, "email")], [allowed, allowed]);
  assert.deepEqual(await on(atClient, "linkedin"), refusedOn("never_contact_company", "all"));
});

test("a relationship is a company's, on its domain, from its own field, and an opt-out is on every channel: a person's, an opt-out's or a page's relationship, a layer named relationship, an unknown kind or channel, and an opt-out on one channel are contacts_input_invalid; nothing is written", async () => {
  const personId = await personAt("ines-no-relationship");
  const page = await run(async () => {
    const company = { name: "Rival Page", linkedinUrl: "https://linkedin.com/company/rival-page" };
    return (await upsertCompany({ source: "import", provider: "csv", company })).company;
  });
  const cases = [
    [{ kind: "person", personId, relationship: "customer" }, ["relationship"]],
    [{ kind: "person", personId, layer: "opt_out", relationship: "customer" }, ["relationship"]],
    [
      { kind: "company", value: "linkedin.com/company/rival-page", relationship: "competitor" },
      ["relationship"],
    ],
    [{ kind: "company", companyId: page.id, relationship: "competitor" }, ["relationship"]],
    [{ kind: "company", value: "rival.example", layer: "relationship" }, ["layer"]],
    [{ kind: "company", value: "rival.example", relationship: "partner" }, ["relationship"]],
    [{ kind: "company", value: "rival.example", channel: "sms" }, ["channel"]],
    [{ kind: "person", personId, layer: "opt_out", channel: "email" }, ["channel"]],
  ] as const;
  for (const [input, fields] of cases) {
    const invalid = { code: "contacts_input_invalid", details: { fields } };
    await assert.rejects(block(input as never), invalid, JSON.stringify(input));
  }
  assert.equal(
    await asRole("app").suppressionEntry.count({ where: { workspaceId: WORKSPACE } }),
    0,
  );
});

test("the database holds the rules for any writer: an opt-out on one channel, a relationship entry without its kind or on a page, and a kind on another layer each fail a CHECK (23514)", async () => {
  type Row = {
    layer: string;
    matchType: string;
    channel: string;
    relationship: string | null;
    linkedinUrl?: string;
    domain?: string;
  };
  const insert = (hash: string, row: Row) => asRole("app").$executeRaw`
    INSERT INTO suppression_entries
      (id, workspace_id, layer, match_type, hash, linkedin_url, domain, channel, relationship, source)
    VALUES (${`sup_check_${hash}`}, ${WORKSPACE}, ${row.layer}::suppression_layer,
      ${row.matchType}::suppression_match_type, ${hash}, ${row.linkedinUrl ?? null},
      ${row.domain ?? null}, ${row.channel}::suppression_channel,
      ${row.relationship}::suppression_relationship, 'manual')`;
  const profile = { matchType: "linkedin_url", linkedinUrl: "https://linkedin.com/in/ines-check" };
  const page = { matchType: "linkedin_url", linkedinUrl: "https://linkedin.com/company/check" };
  const domain = { matchType: "domain", domain: "check.example" };
  const refusedRows: [string, Row][] = [
    ["opt-out-linkedin", { layer: "opt_out", channel: "linkedin", relationship: null, ...profile }],
    ["opt-out-email", { layer: "opt_out", channel: "email", relationship: null, ...profile }],
    ["no-kind", { layer: "relationship", channel: "all", relationship: null, ...domain }],
    ["on-a-page", { layer: "relationship", channel: "all", relationship: "competitor", ...page }],
    ["kind-on-block", { layer: "blocklist", channel: "all", relationship: "customer", ...domain }],
  ];
  for (const [hash, row] of refusedRows) {
    assert.equal(await sqlstate(insert(hash, row)), "23514", `check_violation: ${hash}`);
  }
  const keptRows: [string, Row][] = [
    [
      "customer-email",
      { layer: "relationship", channel: "email", relationship: "customer", ...domain },
    ],
    ["block-linkedin", { layer: "blocklist", channel: "linkedin", relationship: null, ...profile }],
  ];
  for (const [hash, row] of keptRows) {
    assert.equal(await sqlstate(insert(hash, row)), undefined, hash);
  }
});

test("an entry on one channel moves no lead, a person's or a company's, LinkedIn-only or email-only; the same entry on every channel does", async () => {
  const person = await leadAt("ines-one-channel");
  const colleague = await leadAt("ines-one-channel-colleague", { domain: "one-channel.example" });
  await block({ kind: "person", personId: person, channel: "linkedin" });
  await block({ kind: "company", value: "one-channel.example", channel: "email" });
  const statuses = async () => [
    (await leadOf(person)).outreachStatus,
    (await leadOf(colleague)).outreachStatus,
  ];
  assert.deepEqual(await statuses(), ["pending_review", "pending_review"]);
  assert.equal(await asRole("app").leadStatusChange.count(), 0);
  await block({ kind: "person", personId: person });
  await block({ kind: "company", value: "one-channel.example" });
  assert.deepEqual(await statuses(), ["suppressed", "suppressed"]);
});

test("suppressionsOf answers each person as suppressionOf does, for a new enrollment or not, with no channel or on each one; an id of no person, or off the id rules, is person_not_found", async () => {
  const company = { domain: "batch-mix.example" };
  const [clear, blocked, atCompany, optedOut, touched, onLinkedin, onEmail, rivalOf] = [
    await personAt("ines-mix-clear"),
    await personAt("ines-mix-blocked"),
    await personAt("ines-mix-at-company", company),
    await personAt("ines-mix-opted-out"),
    await personAt("ines-mix-touched"),
    await personAt("ines-mix-linkedin"),
    await personAt("ines-mix-email"),
    await personAt("ines-mix-rival", { domain: "eu.mix-rival.example" }),
  ];
  await block({ kind: "person", personId: blocked });
  await block({ kind: "company", value: "batch-mix.example" });
  await run(() => addOptOut(optedOut, { source: "system", reason: "email_unsubscribe" }));
  await run(() => recordTouch(touched, new Date(Date.now() - DAY_MS)));
  await block({ kind: "person", personId: onLinkedin, channel: "linkedin" });
  await block({ kind: "person", personId: onEmail, channel: "email" });
  await block({ kind: "company", value: "mix-rival.example", relationship: "competitor" });
  const ids = [
    ...[clear, blocked, atCompany, optedOut, touched, onLinkedin, onEmail, rivalOf],
    "per_00000000000000000000000000",
    "",
    clear,
  ];
  for (const newEnrollment of [true, false]) {
    for (const channel of READS) {
      const options = { newEnrollment, channel };
      const batch = await run(() => suppressionsOf(ids, options));
      const one = new Map<string, unknown>();
      for (const id of ids) one.set(id, await run(() => suppressionOf(id, options)));
      assert.deepEqual(batch, one, JSON.stringify(options));
    }
  }
  assert.deepEqual(await run(() => suppressionsOf([], { newEnrollment: true })), new Map());
});

test("suppressionsOf reads 1 person and 500 in the same queries, one of the persons, one of their address hashes, one of their companies and one of the entries; 501 ids are contacts_input_invalid naming personIds", async () => {
  const inputs = Array.from(
    { length: SUPPRESSION_BATCH_SIZE },
    (_, index) =>
      ({
        source: "import",
        provider: "csv",
        profile: { linkedinUrl: `https://linkedin.com/in/ines-batch-${index}`, firstName: "Ines" },
      }) as const,
  );
  const ids = await run(async () =>
    (await upsertPersonsFromSource(inputs)).map((written) =>
      "person" in written ? written.person.id : assert.fail(written.code),
    ),
  );
  const companies = await run(async () => {
    const domains = ["batch-0.example", "batch-1.example", "batch-2.example"];
    const written = [];
    for (const domain of domains) {
      const company = { name: `Company ${domain}`, domain };
      written.push(
        (await upsertCompany({ source: "import", provider: "csv", company })).company.id,
      );
    }
    return written;
  });
  const CHUNK = 100;
  for (let start = 0; start < ids.length; start += CHUNK) {
    await run(async () => {
      for (const [offset, personId] of ids.slice(start, start + CHUNK).entries()) {
        const companyId = companies[(start + offset) % companies.length] as string;
        await linkPersonToCompany({ personId, companyId });
      }
    });
  }
  await block({ kind: "company", value: "batch-0.example" });
  await block({ kind: "person", personId: ids[1] as string, channel: "email" });
  const address = "ines-batch-2@harbor.example";
  await run(() => recordPersonEmail({ personId: ids[2] as string, address }));
  await block({ kind: "person", value: address });

  let reads: string[] = [];
  const counting = asRole("app").$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        reads.push(model === undefined ? operation : `${model}.${operation}`);
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  const counted = async (personIds: readonly string[]) => {
    reads = [];
    const answers = await withTenant(
      { workspaceId: WORKSPACE, principal },
      () => suppressionsOf(personIds, { newEnrollment: true, channel: "linkedin" }),
      { client: counting },
    );
    return { reads, answers };
  };
  const one = await counted(ids.slice(0, 1));
  const many = await counted(ids);
  assert.deepEqual(one.reads, many.reads);
  assert.deepEqual(
    many.reads.filter((read) => read.includes(".")),
    [
      "Person.findMany",
      "PersonEmailHash.findMany",
      "WorkspaceCompany.findMany",
      "SuppressionEntry.findMany",
    ],
  );
  assert.equal(many.answers.size, SUPPRESSION_BATCH_SIZE);
  assert.deepEqual(
    [0, 1, 2].map((index) => many.answers.get(ids[index] as string)),
    [refusedOn("never_contact_company", "all"), allowed, refusedOn("never_contact_person", "all")],
  );
  const tooMany = [...ids, "per_00000000000000000000000000"];
  await assert.rejects(
    run(() => suppressionsOf(tooMany, { newEnrollment: false })),
    {
      code: "contacts_input_invalid",
      details: { fields: ["personIds"] },
    },
  );
});

test("suppressedAt on a channel answers as of the send: an entry on that channel counts from its creation until its removal, one on the other channel never; with no channel, both", async () => {
  const personId = await personAt("ines-send-history");
  const { entry: onLinkedin } = await block({ kind: "person", personId, channel: "linkedin" });
  await run(() => removeSuppression(onLinkedin.id, { removedBy: USER }));
  const { entry: onEmail } = await block({ kind: "person", personId, channel: "email" });
  // Back in time, as the owner: LinkedIn's from three hours ago to one; email's from two hours ago.
  const now = Date.now();
  const hoursAgo = (hours: number) => new Date(now - hours * HOUR_MS);
  await asRole("owner").$executeRaw`
    UPDATE suppression_entries SET created_at = ${hoursAgo(3)}, removed_at = ${hoursAgo(1)}
    WHERE id = ${onLinkedin.id}`;
  await asRole("owner").$executeRaw`
    UPDATE suppression_entries SET created_at = ${hoursAgo(2)} WHERE id = ${onEmail.id}`;
  const at = (hours: number, channel?: SuppressionChannel) =>
    run(() => suppressedAt(personId, hoursAgo(hours), { channel }));
  const person = "never_contact_person";
  assert.deepEqual(await at(4, "linkedin"), allowed, "before LinkedIn's");
  assert.deepEqual(await at(2.5, "linkedin"), refusedOn(person, "linkedin"));
  assert.deepEqual(await at(2.5, "email"), allowed, "before email's");
  assert.deepEqual(await at(2.5), refused(person));
  assert.deepEqual(await at(0.5, "linkedin"), allowed, "LinkedIn's removed by then");
  assert.deepEqual(await at(0.5, "email"), refusedOn(person, "email"));
  assert.deepEqual(await at(0.5, "all"), allowed);
  assert.deepEqual(await at(0.5), refused(person));
});

test("contacts.suppression_added carries the entry's channel; a payload written before channels, with none, is read as all", async () => {
  const personId = await personAt("ines-event-channel");
  const { entry } = await block({ kind: "person", personId, channel: "email" });
  const where = { workspaceId: WORKSPACE, eventName: "contacts.suppression_added" };
  const rows = await asRole("app").outboxEntry.findMany({ where });
  assert.deepEqual(
    rows.map((row) => row.payload),
    [{ suppressionId: entry.id, layer: "blocklist", channel: "email" }],
  );
  const before = { suppressionId: "sup_before_channels", layer: "opt_out" };
  assert.deepEqual(parseEventPayload(events["contacts.suppression_added"], before), {
    ...before,
    channel: "all",
  });
});

test("an email entry: a person's value that is no profile is an address, trimmed and in lower case and nothing else folded, matched as the own entry of whoever holds it; the list answers its address and its holder, or none; a value that is neither is suppression_target_invalid", async () => {
  const holder = await personAt("ines-address");
  const tagged = await personAt("ines-tagged-address");
  const dotted = await personAt("ines-dotted-address");
  await run(async () => {
    await recordPersonEmail({ personId: holder, address: "ines@harbor.example" });
    await recordPersonEmail({ personId: tagged, address: "ines+news@harbor.example" });
    await recordPersonEmail({ personId: dotted, address: "i.nes@harbor.example" });
  });
  const { entry } = await block({ kind: "person", value: "  Ines@Harbor.EXAMPLE " });
  assert.deepEqual(
    [entry.matchType, entry.email, entry.linkedinUrl, entry.domain, entry.channel],
    ["email", "ines@harbor.example", null, null, "all"],
  );
  assert.deepEqual(await check(holder), refused("never_contact_person"));
  assert.deepEqual(await check(tagged), allowed, "a +tag is another address");
  assert.deepEqual(await check(dotted), allowed, "a dot is another address");
  const { entry: nobody } = await block({ kind: "person", value: "nobody@harbor.example" });
  const { entries } = await run(() => listSuppression({ limit: 10 }));
  const listed = (id: string) => {
    const row = entries.find((each) => each.id === id);
    return [row?.matchType, row?.email, row?.personId, row?.companyId, row?.displayName];
  };
  assert.deepEqual(listed(entry.id), ["email", "ines@harbor.example", holder, null, "Ines"]);
  assert.deepEqual(listed(nobody.id), ["email", "nobody@harbor.example", null, null, null]);
  const neither = [
    "not an address",
    "ines@",
    "@harbor.example",
    "ines@harbor",
    "Ines <ines@harbor.example>",
    "https://example.com/in/ines",
  ];
  for (const value of neither) {
    await assert.rejects(block({ kind: "person", value }), { code: "suppression_target_invalid" });
  }
});

test("recordPersonEmail: one address on one person: the same person again is self, another person other_person with nothing written, and no address stored; an entry on every channel or on email answers suppressed, one on LinkedIn not; no address is contacts_input_invalid naming address, an unknown person person_not_found", async () => {
  const first = await personAt("ines-holder-one");
  const second = await personAt("ines-holder-two");
  const record = (personId: string, address: string) =>
    run(() => recordPersonEmail({ personId, address }));
  const free = { holder: "self", suppressed: false };
  assert.deepEqual(await record(first, "held@harbor.example"), free);
  assert.deepEqual(await record(first, " HELD@harbor.example"), free);
  assert.deepEqual(await record(second, "held@harbor.example"), {
    holder: "other_person",
    suppressed: false,
  });
  const rows = await asRole("app").personEmailHash.findMany();
  assert.deepEqual(
    rows.map(({ personId }) => personId),
    [first],
  );
  assert.ok(!JSON.stringify(rows).includes("held"), "no address stored");
  await block({ kind: "person", value: "linkedin-only@harbor.example", channel: "linkedin" });
  assert.deepEqual(await record(first, "linkedin-only@harbor.example"), free);
  await block({ kind: "person", value: "email-only@harbor.example", channel: "email" });
  assert.deepEqual(await record(first, "email-only@harbor.example"), {
    holder: "self",
    suppressed: true,
  });
  await assert.rejects(record(first, "no address"), {
    code: "contacts_input_invalid",
    details: { fields: ["address"] },
  });
  await assert.rejects(record("per_00000000000000000000000000", "held@harbor.example"), {
    code: "person_not_found",
  });
});

test("suppressedAt and an address: not suppressed before its entry, nor while the address was not yet recorded for the person; suppressed once both were", async () => {
  const personId = await personAt("ines-address-history");
  await run(() => recordPersonEmail({ personId, address: "history@harbor.example" }));
  const { entry } = await block({ kind: "person", value: "history@harbor.example" });
  // Back in time, as the owner: the entry three hours ago, the address recorded two hours ago.
  const now = Date.now();
  const [created, recorded] = [new Date(now - 3 * HOUR_MS), new Date(now - 2 * HOUR_MS)];
  const owner = asRole("owner");
  await owner.$executeRaw`UPDATE suppression_entries SET created_at = ${created} WHERE id = ${entry.id}`;
  await owner.$executeRaw`
    UPDATE person_email_hashes SET created_at = ${recorded} WHERE person_id = ${personId}`;
  const at = (instant: number) => run(() => suppressedAt(personId, new Date(instant)));
  assert.deepEqual(await at(now - 4 * HOUR_MS), allowed, "before the entry");
  assert.deepEqual(await at(now - 2.5 * HOUR_MS), allowed, "before the address was recorded");
  assert.deepEqual(await at(recorded.getTime()), refused("never_contact_person"), "both by then");
  assert.deepEqual(await at(now), refused("never_contact_person"));
});

/**
 * A person known by an email address alone, no LinkedIn profile (gamma-rf-050), with a lead, at a
 * company with the domain given; its id.
 */
async function addressOnly(email: string, domain?: string) {
  return run(async () => {
    const profile = { email, firstName: "Ines" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    if (domain !== undefined) {
      const company = { name: `Company of ${email}`, domain };
      const { company: row } = await upsertCompany({ source: "import", provider: "csv", company });
      await linkPersonToCompany({ personId: person.id, companyId: row.id });
    }
    const source = { kind: "imported", ref: "imp_1" } as const;
    await createLeadForPerson({ personId: person.id, source });
    return person.id;
  });
}

test("a person without a LinkedIn profile: the check matches their addresses' hashes and their company's; an add by their id and an opt-out lie on each address's hash with no address, the list naming them; a profile person answers as before; erased, the entries keep their hashes and stop the next holder of an address", async () => {
  const app = asRole("app");
  const plain = await addressOnly("ines.plain@nolink.example");
  const atCompany = await addressOnly("ines.company@nolink.example", "blocked-nolink.example");
  const byId = await addressOnly("ines.by-id@nolink.example");
  const optedOut = await addressOnly("ines.opted-out@nolink.example");
  const home = "ines.opted-out.home@nolink.example";
  await run(() => recordPersonEmail({ personId: optedOut, address: home }));
  const withProfile = await personAt("ines-with-profile");
  for (const personId of [plain, atCompany, byId, optedOut, withProfile]) {
    assert.deepEqual(await check(personId), allowed, personId);
  }
  await block({ kind: "company", value: "blocked-nolink.example" });
  await block({ kind: "person", personId: byId });
  await block({ kind: "person", personId: withProfile });
  const optOut = await run(() => addOptOut(optedOut, { source: "system", reason: "complaint" }));
  assert.deepEqual(
    [optOut.created, optOut.entry.matchType, optOut.entry.email],
    [true, "email", null],
  );
  assert.deepEqual(await check(plain), allowed);
  assert.deepEqual(await check(atCompany), refused("never_contact_company"));
  assert.deepEqual(await check(byId), refused("never_contact_person"));
  assert.deepEqual(await check(withProfile), refused("never_contact_person"));
  for (const channel of [undefined, "linkedin", "email"] as const) {
    const answer = await run(() => suppressionOf(optedOut, { newEnrollment: false, channel }));
    assert.equal(answer.suppressed && answer.reason, "opted_out", channel ?? "no channel");
  }
  const statusOf = async (personId: string) =>
    (await app.lead.findFirstOrThrow({ where: { personId } })).outreachStatus;
  assert.deepEqual(await Promise.all([plain, atCompany, byId, optedOut].map(statusOf)), [
    "pending_review",
    "suppressed",
    "suppressed",
    "suppressed",
  ]);
  const hashesOf = async (personId: string) =>
    (await app.personEmailHash.findMany({ where: { personId } })).map(({ hash }) => hash).sort();
  const own = await app.suppressionEntry.findMany({
    where: { layer: { in: ["blocklist", "opt_out"] }, matchType: { not: "domain" } },
  });
  const on = (hashes: readonly string[]) =>
    own
      .filter(({ hash }) => hashes.includes(hash))
      .map(({ matchType, email, linkedinUrl }) => [matchType, email, linkedinUrl]);
  assert.deepEqual(on(await hashesOf(byId)), [["email", null, null]]);
  const optedOutHashes = await hashesOf(optedOut);
  assert.deepEqual(on(optedOutHashes), [
    ["email", null, null],
    ["email", null, null],
  ]);
  const profileEntry = own.find(({ matchType }) => matchType === "linkedin_url");
  assert.equal(profileEntry?.linkedinUrl, "https://linkedin.com/in/ines-with-profile");
  const { entries } = await run(() => listSuppression({ limit: 50 }));
  const named = entries.filter(({ matchType }) => matchType === "email");
  assert.deepEqual(
    named.map(({ personId, displayName }) => [
      personId === byId || personId === optedOut,
      displayName,
    ]),
    [
      [true, "Ines"],
      [true, "Ines"],
      [true, "Ines"],
    ],
  );
  // Privacy's 30-day rule: no erased hash; the entries keep their hashes, and stop whoever holds the
  // address next.
  await run(() => erasePerson(optedOut, { writeErasedHash: false }));
  const left = await app.suppressionEntry.findMany({
    where: { hash: { in: optedOutHashes }, removedAt: null },
  });
  assert.deepEqual(left.map(({ hash }) => hash).sort(), optedOutHashes);
  const next = await addressOnly(home);
  assert.deepEqual(await check(next), refused("opted_out"));
});
