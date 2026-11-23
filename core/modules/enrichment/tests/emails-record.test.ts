// `pnpm -F enrichment emails:record` (gamma-rf-040; cli/emails-record.ts) on the worktree's database:
// the contact points kept before contacts knew their hashes, in two workspaces and whatever their
// status, recorded for their persons; one whose address is blocked, and one whose address another
// person holds, printed by id, the first person then stopped and their lead suppressed; one whose
// value is no address refused by id; no contact point changed; a second run changes nothing; ids and
// counts only.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createLeadForPerson,
  recordPersonEmail,
  suppressionOf,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { addSuppression, useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { runEmailsRecord } from "../cli/emails-record.ts";
import { ids } from "../ids.ts";
import { useEnrichmentClient } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
useEnrichmentClient(app);
useTenancyClient(app);
const principal = servicePrincipal("enrichment_test");
const AT = new Date("2026-11-14T10:00:00Z");

/** A person of the workspace with a lead. */
const personIn = (workspaceId: string, slug: string) =>
  withTenant(
    { workspaceId, principal },
    async () => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      await createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      return person.id;
    },
    { client: app },
  );
/** A contact point as a settle wrote one before contacts knew its hash. */
async function pointOf(
  workspaceId: string,
  personId: string,
  value: string,
  status: "active" | "bounced" = "active",
) {
  const id = newId(ids.contact_point);
  await app.contactPoint.create({
    data: {
      ...{ id, workspaceId, personId, kind: "work_email", value, verification: "valid", status },
      ...{ verifiedAt: AT, sourceClass: "email_finder", provider: "fake", acquiredAt: AT },
      legalBasis: "legitimate_interest",
    },
  });
  return id;
}

test("every contact point of every workspace is recorded for its person, whatever its status; a blocked address and one another person holds are printed by id, the first's person stopped; one that is no address refused; no contact point changes; a second run changes nothing", async () => {
  const [{ workspace: a }, { workspace: b }] = await createTwoWorkspaces();
  const inA = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId: a.id, principal }, fn, { client: app });
  const active = await personIn(a.id, "record-active");
  const bounced = await personIn(a.id, "record-bounced");
  const blocked = await personIn(a.id, "record-blocked");
  const holder = await personIn(a.id, "record-holder");
  const second = await personIn(a.id, "record-second");
  const odd = await personIn(a.id, "record-odd");
  const theirs = await personIn(b.id, "record-theirs");
  await inA(async () => {
    const value = "noor.blocked@example.com";
    await addSuppression({ kind: "person", value, createdBy: "usr_record" });
    // The address recorded for another person, before the deploy's contact point of `second`.
    await recordPersonEmail({ personId: holder, address: "shared@example.com" });
  });
  const points = {
    active: await pointOf(a.id, active, "noor.active@example.com"),
    bounced: await pointOf(a.id, bounced, "noor.bounced@example.com", "bounced"),
    blocked: await pointOf(a.id, blocked, "noor.blocked@example.com"),
    shared: await pointOf(a.id, second, "shared@example.com"),
    odd: await pointOf(a.id, odd, "Noor <noor.odd@example.com>"),
    theirs: await pointOf(b.id, theirs, "noor.active@example.com"),
  };
  const before = await app.contactPoint.findMany({ orderBy: { id: "asc" } });
  const printed: string[] = [];
  assert.equal(await runEmailsRecord([], (line) => printed.push(line), app), 0);
  assert.deepEqual(printed.toSorted(), [
    `blocked: ${points.blocked}`,
    "emails_recorded: 4 recorded, 1 of them blocked, 1 held by another person, 1 refused, 0 gone, of 6 read in 2 workspaces",
    `other_person: ${points.shared}`,
    `refused: ${points.odd} (contacts_input_invalid)`,
  ]);
  assert.ok(!printed.join("\n").includes("@"), "no address printed");
  const hashes = await app.personEmailHash.findMany();
  assert.deepEqual(
    hashes.map(({ personId }) => personId).toSorted(),
    [active, bounced, blocked, holder, theirs].toSorted(),
  );
  assert.deepEqual(await app.contactPoint.findMany({ orderBy: { id: "asc" } }), before);
  const lead = await app.lead.findFirstOrThrow({ where: { personId: blocked } });
  assert.equal(lead.outreachStatus, "suppressed");
  assert.deepEqual(await inA(() => suppressionOf(blocked, { newEnrollment: false })), {
    suppressed: true,
    reason: "never_contact_person",
  });
  assert.deepEqual(await inA(() => suppressionOf(active, { newEnrollment: false })), {
    suppressed: false,
  });

  const again: string[] = [];
  assert.equal(await runEmailsRecord(["--workspace", a.id], (line) => again.push(line), app), 0);
  assert.equal(
    again.at(-1),
    "emails_recorded: 3 recorded, 1 of them blocked, 1 held by another person, 1 refused, 0 gone, of 5 read in 1 workspaces",
  );
  assert.equal(await app.personEmailHash.count(), hashes.length);
  assert.deepEqual(await app.contactPoint.findMany({ orderBy: { id: "asc" } }), before);
  const usage: string[] = [];
  assert.equal(await runEmailsRecord(["--everything"], (line) => usage.push(line), app), 2);
  assert.deepEqual(usage, ["usage: pnpm -F enrichment emails:record [--workspace <id>]"]);
});
