// The countries' backfill (README "The place list", gamma-en-075; cli/countries-backfill.ts) on the
// worktree's database: it fills only empty countries the list can read now, with the location's
// provenance, keeps a member's value and a recorded country, works in batches of 500, in one
// workspace or every one, and prints counts only.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { runCountriesBackfill } from "../cli/countries-backfill.ts";
import { upsertPersonsFromSource } from "../domain/batch.ts";
import { backfillCountries } from "../domain/countries-backfill.ts";
import { upsertPersonFromSource } from "../domain/persons.ts";
import { useHashSalt, usePlaces } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
useTenancyClient(app);
const principal = servicePrincipal("contacts_test");
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const linkedin = { source: "linkedin" as const, provider: "unipile" };
const MEMBER = { source: "member", provider: null, at: "2026-11-01T00:00:00.000Z" };

/** A person whose location the list could not read when it was written: the list empty then. */
async function unread(workspaceId: string, slug: string, locationText: string) {
  usePlaces("# empty");
  const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, locationText };
  const { person } = await run(workspaceId, () => upsertPersonFromSource({ ...linkedin, profile }));
  usePlaces(undefined);
  assert.equal(person.locationCountry, null, slug);
  return person.id;
}
const personOf = (workspaceId: string, id: string) =>
  run(workspaceId, (tx) => tx.person.findUniqueOrThrow({ where: { id } }));

test("the backfill fills only empty countries the list can read now, with the location's provenance; keeps a member's value and a country already there; prints counts only", async () => {
  const [{ workspace: a }, { workspace: b }] = await createTwoWorkspaces();
  const boston = await unread(a.id, "bf-boston", "Boston, MA");
  const ruhr = await unread(a.id, "bf-ruhr", "Ruhr Region");
  const kept = await unread(a.id, "bf-member", "Lyon");
  await run(a.id, (tx) =>
    tx.person.update({
      where: { id: kept },
      data: { fieldProvenance: { locationText: MEMBER, locationCountry: MEMBER } },
    }),
  );
  const set = await unread(a.id, "bf-set", "Greater Toronto Area");
  await run(a.id, (tx) =>
    tx.person.update({ where: { id: set }, data: { locationCountry: "GB" } }),
  );
  const other = await unread(b.id, "bf-other", "Greater Munich Metropolitan Area");

  const lines: string[] = [];
  const code = await runCountriesBackfill(["--workspace", a.id], (line) => lines.push(line), app);
  assert.equal(code, 0);
  assert.deepEqual(lines, [
    "countries_backfilled: 1 filled, 1 unread, 1 kept of 3 read in 1 workspaces",
  ]);
  const filled = await personOf(a.id, boston);
  assert.equal(filled.locationCountry, "US");
  const provenance = filled.fieldProvenance as Record<string, unknown>;
  assert.deepEqual(provenance.locationCountry, provenance.locationText);
  assert.equal((await personOf(a.id, ruhr)).locationCountry, null);
  assert.equal((await personOf(a.id, kept)).locationCountry, null, "a member's value kept");
  assert.equal((await personOf(a.id, set)).locationCountry, "GB", "a country there kept");
  assert.equal((await personOf(b.id, other)).locationCountry, null, "another workspace untouched");

  lines.length = 0;
  assert.equal(await runCountriesBackfill([], (line) => lines.push(line), app), 0);
  assert.match(
    lines[0] ?? "",
    /^countries_backfilled: 1 filled, 1 unread, 1 kept of 3 read in \d+ workspaces$/,
  );
  assert.equal((await personOf(b.id, other)).locationCountry, "DE");
  assert.equal(await runCountriesBackfill(["--bad"], (line) => lines.push(line), app), 2);
});

test("the backfill works in batches of 500, in id order: 501 persons are two batches, every one filled", async () => {
  const [{ workspace }] = await createTwoWorkspaces();
  usePlaces("# empty");
  const inputs = Array.from({ length: 501 }, (_, index) => ({
    ...linkedin,
    profile: { linkedinUrl: `https://linkedin.com/in/bf-${index}`, locationText: "Lyon" },
  }));
  await run(workspace.id, () => upsertPersonsFromSource(inputs));
  usePlaces(undefined);
  const first = await run(workspace.id, () => backfillCountries(null));
  assert.deepEqual(
    { ...first, last: undefined },
    { read: 500, filled: 500, kept: 0, unread: 0, last: undefined },
  );
  const second = await run(workspace.id, () => backfillCountries(first.last));
  assert.deepEqual([second.read, second.filled], [1, 1]);
  assert.equal((await run(workspace.id, () => backfillCountries(second.last))).last, null);
  const lines: string[] = [];
  await runCountriesBackfill(["--workspace", workspace.id], (line) => lines.push(line), app);
  assert.deepEqual(lines, [
    "countries_backfilled: 0 filled, 0 unread, 0 kept of 0 read in 1 workspaces",
  ]);
  const left = await run(workspace.id, (tx) =>
    tx.person.count({ where: { locationCountry: null } }),
  );
  assert.equal(left, 0);
});
