// The safety cases of a person's phone (gamma-wr-100, send path, personal data; docs/security.md "A
// phone is never an address"), run by `pnpm -F enrichment test:safety`: a phone sits in the table the
// send path reads, so every reader of an address names the email kinds it takes, and none answers a
// phone, whatever its verification columns, its date or its status says; the re-verification sends
// no phone to a verifier; the record of the persons' addresses reads no phone; the table keeps an
// email row as strict as ever (verification and verified_at, for both email kinds) and asks neither
// of a phone; a number is kept for nobody on the never-contact list, never for a second person, and
// goes with the person it was kept for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { addSuppression, useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { erasePerson } from "../../domain/erase.ts";
import { addressOf, markBounced, workEmailOf } from "../../domain/lookup/addresses.ts";
import { EMAIL_KINDS } from "../../domain/lookup/constants.ts";
import { activePoint, usablePoint } from "../../domain/lookup/points.ts";
import { prepareLookup } from "../../domain/lookup/prepare.ts";
import { contactPointsAfter, recordContactPoint } from "../../domain/lookup/record-emails.ts";
import { requestLookup, requestReverification } from "../../domain/lookup/request.ts";
import { verifyCandidate } from "../../domain/lookup/verify.ts";
import { keepPhone } from "../../domain/phone/keep.ts";
import { ids } from "../../ids.ts";
import { useEnrichmentClient, usePersonalEmailEuUk } from "../../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useEnrichmentClient(asRole("app"));
const WS = "wsp_enrichment_phones";
const principal = servicePrincipal("enrichment_phones");
const app = asRole("app");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: app });
const AT = new Date("2026-11-19T10:00:00Z");
const LATER = new Date("2026-11-19T11:00:00Z");
const PAGE = "https://example.com/team";

/** A person of the workspace, in the US unless `place` says otherwise, with an address as a key if given. */
const personAt = (slug: string, own: { place?: string; email?: string } = {}) =>
  run(async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/${slug}`,
      firstName: "Noor",
      locationText: own.place ?? "Austin, United States",
      ...(own.email !== undefined && { email: own.email }),
    };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    return person.id;
  });

type Row = {
  kind: "work_email" | "personal_email" | "phone";
  value: string;
  verification?: "valid" | "catch_all" | "risky" | "invalid" | "unknown" | null;
  verifiedAt?: Date | null;
  status?: "active" | "bounced" | "opted_out";
};
/** A contact point as the table takes it; verification and date as given, null for none. */
async function row(personId: string, values: Row): Promise<string> {
  const id = newId(ids.contact_point);
  const { kind, value, status = "active" } = values;
  await app.contactPoint.create({
    data: {
      ...{ id, workspaceId: WS, personId, kind, value, status },
      verification: values.verification === undefined ? "valid" : values.verification,
      verifiedAt: values.verifiedAt === undefined ? AT : values.verifiedAt,
      ...{ sourceClass: "website", provider: "website", acquiredAt: AT },
      legalBasis: "legitimate_interest",
    },
  });
  return id;
}
/** A phone row as hostile as a row can be: valid, verified, and newer than any address. */
const hostilePhone = (personId: string, value = "+48221234567") =>
  row(personId, { kind: "phone", value, verification: "valid", verifiedAt: LATER });

test("the readers of the send path never answer a phone: workEmailOf and addressOf answer nothing for a person whose only contact point is a phone, whatever its verification, its date or its page says", async () => {
  const personId = await personAt("phone-only");
  const bare = await row(personId, {
    ...{ kind: "phone", value: "+48221110001" },
    ...{ verification: null, verifiedAt: null },
  });
  const hostile = await hostilePhone(personId);
  assert.equal(await run(() => workEmailOf(personId)), null);
  for (const id of [bare, hostile]) assert.equal(await run(() => addressOf(id)), null);
  usePersonalEmailEuUk(true);
  assert.equal(await run(() => workEmailOf(personId)), null);
  usePersonalEmailEuUk(undefined);
});

test("a bounce is for an address: markBounced on a phone's contact point changes nothing, and writes no cache entry", async () => {
  const personId = await personAt("bounce-phone");
  const phone = await hostilePhone(personId, "+48221110009");
  await run(() => markBounced(phone, { at: AT }));
  const row = await app.contactPoint.findUniqueOrThrow({ where: { id: phone } });
  assert.equal(row.status, "active");
  assert.equal(await app.enrichmentCacheEntry.count({ where: { personId } }), 0);
});

test("a phone never takes an address's place: with a work address, a personal one or none usable, workEmailOf answers the address and never a newer phone", async () => {
  const work = await personAt("phone-and-work");
  const workId = await row(work, { kind: "work_email", value: "noor@example.com" });
  await hostilePhone(work, "+48221110002");
  assert.equal((await run(() => workEmailOf(work)))?.contactPointId, workId);
  // A personal address that waits for consent is not answered, and no phone answers in its place.
  const waiting = await personAt("phone-and-personal", { place: "Paris, France" });
  await row(waiting, { kind: "personal_email", value: "noor.p@gmail.com" });
  await hostilePhone(waiting, "+48221110003");
  assert.equal(await run(() => workEmailOf(waiting)), null);
  // An address that is not valid is not answered, and no phone answers in its place.
  const invalid = await personAt("phone-and-invalid");
  await row(invalid, { kind: "work_email", value: "noor.i@example.com", verification: "invalid" });
  await hostilePhone(invalid, "+48221110004");
  assert.equal(await run(() => workEmailOf(invalid)), null);
});

test("the lookup's own readers name the email kinds: usablePoint and activePoint answer no phone, and a person with only a phone has no held address", async () => {
  assert.deepEqual([...EMAIL_KINDS], ["work_email", "personal_email"]);
  const personId = await personAt("held-phone");
  await hostilePhone(personId);
  for (const personal of [false, true]) {
    assert.equal(await run(() => usablePoint(personId, personal)), null);
  }
  assert.equal(await run(() => activePoint(personId)), null);
  const email = await row(personId, { kind: "work_email", value: "held@example.com" });
  assert.equal((await run(() => activePoint(personId)))?.id, email);
});

test("a re-verification sends no phone to a verifier: for a person with a phone only it ends not_found with no address and starts no verifier; with an address as well, it holds the address's contact point; a request forged to a phone's contact point is failed by the verify step, with no step recorded", async () => {
  const phoneOnly = await personAt("reverify-phone");
  await hostilePhone(phoneOnly);
  const { requestId } = await run(() =>
    requestReverification({ personId: phoneOnly, requestKey: "rv-phone" }),
  );
  const loaded = { sources: [], verifiers: [], leftOut: [] };
  const plan = await run(() => prepareLookup(requestId, loaded, true));
  assert.deepEqual(plan, { settled: true, status: "not_found" });
  const ended = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: requestId } });
  assert.deepEqual(
    [ended.status, ended.reason, ended.contactPointId],
    ["not_found", "no_address", null],
  );

  const both = await personAt("reverify-both");
  const email = await row(both, { kind: "work_email", value: "both@example.com" });
  await hostilePhone(both, "+48221110005");
  const second = await run(() => requestReverification({ personId: both, requestKey: "rv-both" }));
  const started = await run(() => prepareLookup(second.requestId, loaded, true));
  assert.equal(started.settled, false);
  const running = await app.enrichmentRequest.findUniqueOrThrow({
    where: { id: second.requestId },
  });
  assert.deepEqual([running.status, running.contactPointId], ["running", email]);

  // The request names a phone, as no code of ours writes it: the step takes no address from it.
  const phone = await hostilePhone(both, "+48221110006");
  await app.enrichmentRequest.update({
    where: { id: second.requestId },
    data: { contactPointId: phone },
  });
  const runs = { workspaceId: WS, tenant: run };
  const result = await verifyCandidate(runs, {
    requestId: second.requestId,
    n: 0,
    verifier: "email-verifier/fake",
  });
  assert.deepEqual(result, { outcome: "failed", personal: false });
  const after = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: second.requestId } });
  assert.deepEqual(after.providersTried, []);
});

test("a lookup for a person with only a phone is a lookup for an address: it keeps no phone as the found address", async () => {
  const personId = await personAt("lookup-phone");
  await hostilePhone(personId);
  const { requestId } = await run(() => requestLookup({ personId, requestKey: "lk-phone" }));
  const loaded = { sources: [], verifiers: [], leftOut: [] };
  await run(() => prepareLookup(requestId, loaded, true));
  const request = await app.enrichmentRequest.findUniqueOrThrow({ where: { id: requestId } });
  assert.notEqual(request.status, "found");
  assert.equal(request.contactPointId, null);
});

test("the record of the persons' addresses reads no phone: its batches list none and recording one is as if it were gone", async () => {
  const personId = await personAt("record-phone");
  const phone = await hostilePhone(personId);
  const email = await row(personId, { kind: "work_email", value: "record@example.com" });
  const listed = await run(() => contactPointsAfter(null));
  assert.equal(listed.includes(phone), false);
  assert.equal(listed.includes(email), true);
  assert.equal(await run(() => recordContactPoint(phone)), "gone");
});

test("the table keeps an email row as strict as ever: a work or a personal address without its verification, or without its verified_at, is refused by the database (check violation); a phone needs neither, and one with them is as good", async () => {
  const personId = await personAt("check-rows");
  let n = 0;
  for (const kind of ["work_email", "personal_email"] as const) {
    const bare = { verification: null, verifiedAt: null };
    for (const missing of [bare, { verification: null }, { verifiedAt: null }]) {
      n += 1;
      const refused = await sqlstate(
        row(personId, { kind, value: `check-${n}@example.com`, ...missing }),
      );
      assert.equal(refused, "23514", `${kind} ${JSON.stringify(missing)}`);
    }
  }
  await row(personId, { kind: "work_email", value: "check-ok@example.com" });
  await row(personId, {
    ...{ kind: "phone", value: "+48221110007", verification: null, verifiedAt: null },
  });
  assert.equal(await app.contactPoint.count({ where: { personId } }), 2);
});

test("a number is kept for nobody on the never-contact list, whatever its channel, and nothing is written", async () => {
  for (const channel of ["all", "email"] as const) {
    const email = `noor.blocked-${channel}@example.com`;
    const personId = await personAt(`blocked-${channel}`, { email });
    await run(() =>
      addSuppression({ kind: "person", value: email, channel, createdBy: "usr_phones" }),
    );
    const kept = await run(() => keepPhone(personId, { number: "+48 22 123 45 67", page: PAGE }));
    assert.deepEqual([kept.outcome, kept.contactPointId], ["suppressed", null], channel);
    assert.equal(await app.contactPoint.count({ where: { personId } }), 0, channel);
  }
});

test("one number sits on one person: a number another person holds is not kept again, in any form it is printed in, and the first person keeps it", async () => {
  const first = await personAt("holds-first");
  const second = await personAt("holds-second");
  const kept = await run(() => keepPhone(first, { number: "+48 22 123 45 67", page: PAGE }));
  assert.equal(kept.outcome, "kept");
  for (const printed of ["+48 22 123 45 67", "+48-22-123-45-67", "+48 (22) 123 45 67"]) {
    const again = await run(() => keepPhone(second, { number: printed, page: PAGE }));
    assert.deepEqual([again.outcome, again.contactPointId], ["other_person", null], printed);
  }
  assert.equal(await app.contactPoint.count({ where: { personId: second } }), 0);
  assert.equal(await app.contactPoint.count({ where: { value: "+48221234567" } }), 1);
});

test("erasing a person removes their phone with their other contact points, and not another person's", async () => {
  const erased = await personAt("erase-phone");
  const kept = await personAt("keep-phone");
  await run(() => keepPhone(erased, { number: "+48 22 123 45 68", page: PAGE }));
  await run(() => keepPhone(kept, { number: "+48 22 123 45 69", page: PAGE }));
  const counts = await run(() => erasePerson(erased));
  assert.equal(counts.contact_points, 1);
  assert.equal(await app.contactPoint.count({ where: { personId: erased } }), 0);
  assert.equal(await app.contactPoint.count({ where: { personId: kept } }), 1);
});
