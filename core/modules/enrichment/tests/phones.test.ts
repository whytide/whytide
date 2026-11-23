// A person's phone as enrichment keeps it (gamma-wr-100; README "A person's phone"; domain/phone): the
// form (digits, a leading + when printed, 7 to 15 digits, anything else dropped), whether two printed
// numbers are one, the page's address (https, no query), one number on one person in any way of
// printing it, the same person's number again, a person who is gone, and the phones a lead page
// reads. The safety cases (the readers, the table's CHECK, the never-contact list, the eraser) are
// tests/safety/phones.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { leadPhones } from "../domain/lead/phones.ts";
import { cleanPhone, pageOfPhone, samePhone } from "../domain/phone/form.ts";
import { keepPhone } from "../domain/phone/keep.ts";
import { useEnrichmentClient } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const WS = "wsp_enrichment_phones_unit";
const app = asRole("app");
const principal = servicePrincipal("enrichment_phones_unit");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
const PAGE = "https://acme.example/team";
const person = (slug: string) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person: made } = await upsertPersonFromSource({
      ...{ source: "import", provider: "csv" },
      profile,
    });
    return made.id;
  });

test("a number by form only: its digits, a leading + when printed, 7 to 15 of them; a letter, an extension, a second +, 6 or 16 digits, or nothing is dropped; written in two countries' ways, one number", () => {
  const cases: [string, string | null][] = [
    ["+48 22 123 45 67", "+48221234567"],
    ["+52 (55) 1234-5678", "+525512345678"],
    ["(555) 123-4567", "5551234567"],
    ["030 1234.5678", "03012345678"],
    ["  +49 30 12345678  ", "+493012345678"],
    ["1234567", "1234567"],
    ["+123456789012345", "+123456789012345"],
    ["123456", null],
    ["1234567890123456", null],
    ["+49 (0)30 1234 5678", "+493012345678"],
    ["+49 ( 0 ) 30 1234 5678", "+493012345678"],
    ["+48 22 123 45 67 ext. 4", null],
    ["22 123 45 67 x4", null],
    ["+48+22 123 45 67", null],
    ["48 22 123 45 67 +", null],
    ["call 22 123 45 67", null],
    ["tel:+48221234567", null],
    ["", null],
    ["+".repeat(41), null],
  ];
  for (const [printed, kept] of cases) assert.equal(cleanPhone(printed), kept, printed);
  assert.equal(cleanPhone("+48 22 123 45 67"), cleanPhone("+48-22-123-45-67"));
  assert.equal(cleanPhone("+49 (0)30 1234 5678"), cleanPhone("+4930 12345678"));
});

test("two printed numbers are one: the same digits, or one without the other's country code or prefix zeros, the shorter holding at least 7 digits; two numbers that differ in a digit or in their country are not", () => {
  assert.equal(samePhone("+48221234567", "22 123 45 67"), true);
  assert.equal(samePhone("0048 22 123 45 67", "+48 22 123 45 67"), true);
  assert.equal(samePhone("022 123 45 67", "+48 22 123 45 67"), true);
  assert.equal(samePhone("+49 (0)30 1234 5678", "+49 30 1234 5678"), true);
  assert.equal(samePhone("+48221234567", "+48221234568"), false);
  assert.equal(samePhone("+48221234567", "+49301234567"), false);
});

test("the page's address: an http or https page, without its query, fragment or credentials; none for another scheme or an address too long", () => {
  assert.equal(pageOfPhone("https://acme.example/team?id=7#top"), "https://acme.example/team");
  assert.equal(pageOfPhone("https://user:pw@acme.example/a/b"), "https://acme.example/a/b");
  assert.equal(pageOfPhone("http://acme.example/team?x=1"), "http://acme.example/team");
  assert.equal(pageOfPhone("ftp://acme.example/team"), null);
  assert.equal(pageOfPhone("javascript:alert(1)"), null);
  assert.equal(pageOfPhone("not a link"), null);
  assert.equal(pageOfPhone(`https://acme.example/${"a".repeat(2100)}`), null);
});

test("keepPhone keeps the number and its page for the person; the same number again, in another way of printing it, is known, fills a missing page and writes no second row", async () => {
  const personId = await person("keeper");
  const first = await run(() =>
    keepPhone(personId, { number: "+48 22 123 45 67", page: `${PAGE}?utm=1` }),
  );
  assert.equal(first.outcome, "kept");
  const row = await app.contactPoint.findUniqueOrThrow({
    where: { id: first.contactPointId ?? "" },
  });
  assert.deepEqual(
    [row.kind, row.value, row.pageUrl, row.verification, row.verifiedAt, row.status],
    ["phone", "+48221234567", PAGE, null, null, "active"],
  );
  assert.deepEqual([row.sourceClass, row.provider], ["web_page", "research"]);
  const again = await run(() => keepPhone(personId, { number: "22 123 45 67", page: PAGE }));
  assert.deepEqual([again.outcome, again.contactPointId], ["known", row.id]);
  assert.equal(await app.contactPoint.count({ where: { personId } }), 1);

  const bare = await person("keeper-no-page");
  const noPage = await run(() =>
    keepPhone(bare, { number: "+49 30 1234 5678", page: "mailto:x@y.example" }),
  );
  assert.equal(noPage.outcome, "kept");
  const kept = await app.contactPoint.findUniqueOrThrow({
    where: { id: noPage.contactPointId ?? "" },
  });
  assert.equal(kept.pageUrl, null);
  await run(() => keepPhone(bare, { number: "+4930 1234 5678", page: PAGE }));
  assert.equal(
    (await app.contactPoint.findUniqueOrThrow({ where: { id: kept.id } })).pageUrl,
    PAGE,
  );

  // A trunk zero printed in parentheses is not part of the number: stored without it, the same number.
  const trunk = await person("keeper-trunk");
  const printed = await run(() => keepPhone(trunk, { number: "+49 (0)40 1234 5678", page: PAGE }));
  assert.equal(printed.outcome, "kept");
  const stored = await app.contactPoint.findUniqueOrThrow({
    where: { id: printed.contactPointId ?? "" },
  });
  assert.equal(stored.value, "+494012345678");
  const plain = await run(() => keepPhone(trunk, { number: "+4940 12345678", page: PAGE }));
  assert.deepEqual([plain.outcome, plain.contactPointId], ["known", stored.id]);
  assert.equal(await app.contactPoint.count({ where: { personId: trunk } }), 1);
});

test("keepPhone keeps nothing for what is not a number, and for a person who is gone; a person may hold more than one number", async () => {
  const personId = await person("keeper-two");
  for (const number of ["12345", "call me", "+48 22 123 45 67 ext 2"]) {
    const answer = await run(() => keepPhone(personId, { number, page: PAGE }));
    assert.deepEqual([answer.outcome, answer.contactPointId], ["invalid", null], number);
  }
  const gone = await run(() => keepPhone("per_nobody", { number: "+48 22 123 45 67", page: PAGE }));
  assert.equal(gone.outcome, "gone");
  await run(() => keepPhone(personId, { number: "+48 22 555 00 11", page: PAGE }));
  await run(() => keepPhone(personId, { number: "+48 600 700 800", page: PAGE }));
  assert.equal(await app.contactPoint.count({ where: { personId } }), 2);
});

test("leadPhones answers the person's active phones with their pages, oldest first, and none for a person with none; a bounced one is not shown; enrichment_person_not_found for an unknown person", async () => {
  const personId = await person("reader");
  const first = new Date("2026-11-18T08:00:00Z");
  const later = new Date("2026-11-19T08:00:00Z");
  await run(() => keepPhone(personId, { number: "+48 22 777 00 02", page: PAGE }, later));
  await run(() => keepPhone(personId, { number: "+48 22 777 00 01", page: PAGE }, first));
  const hidden = await run(() => keepPhone(personId, { number: "+48 22 777 00 03", page: PAGE }));
  await app.contactPoint.update({
    where: { id: hidden.contactPointId ?? "" },
    data: { status: "bounced" },
  });
  const { phones } = await run(() => leadPhones(personId));
  assert.deepEqual(
    phones.map(({ number, page, acquiredAt }) => [number, page, acquiredAt.toISOString()]),
    [
      ["+48227770001", PAGE, first.toISOString()],
      ["+48227770002", PAGE, later.toISOString()],
    ],
  );
  const none = await person("reader-none");
  assert.deepEqual((await run(() => leadPhones(none))).phones, []);
  await assert.rejects(
    run(() => leadPhones("per_unknown")),
    { code: "enrichment_person_not_found" },
  );
});
