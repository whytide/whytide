// A company's facts from enrichment (gamma-en-040; docs/data.md) on the worktree's database, in this
// file's schema, inside tenant runs as its callers make them: the headcount and the description with
// their provenance; a count given without a size range writes the range as the count's text, which
// qualification's size filter reads (its tests/batch.test.ts: 1234 falls in 1001-5000); the rules
// and the migration's CHECKs bound both. Then the company index (gamma-rf-010), on tenancy's
// workspaces, whose organization is the sharing group: the link, the routing, the one-person rule,
// the race, and the CHECK on what every organization reads.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, newId, servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { readsOnePerson } from "../domain/companies/layers.ts";
import { makeShared } from "../domain/companies/store.ts";
import { getCompany, refreshCompany, upsertCompany } from "../domain/companies.ts";
import { COMPANY_DESCRIPTION_MAX } from "../domain/constants.ts";
import { ids } from "../ids.ts";
import { useHashSalt, useSharedFactSources } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WS = "wsp_companies_test";
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>) =>
  withTenant({ workspaceId: WS, principal }, fn, { client: asRole("app") });
const fails = (code: string, fields: string[]) => (error: unknown) =>
  isAppError(error) &&
  error.code === code &&
  JSON.stringify(error.details?.fields) === JSON.stringify(fields);
const fetchedAt = new Date("2026-11-13T08:00:00Z");
const stamp = { source: "open_data", provider: "wikidata", at: fetchedAt.toISOString() };
const base = { name: "Blue Harbor Labs", domain: "blueharbor.example", fetchedAt };

test('a company upserted with employeeCount 1234 and no sizeRange stores the count and the size range "1234", each with the source\'s provenance, and its description; getCompany reads them', async () => {
  const description = "Blue Harbor Labs builds data tools for logistics teams.";
  const { company, created } = await run(() =>
    upsertCompany({
      source: "open_data",
      provider: "wikidata",
      company: { ...base, employeeCount: 1234, description },
    }),
  );
  assert.equal(created, true);
  assert.deepEqual(
    [company.employeeCount, company.sizeRange, company.description],
    [1234, "1234", description],
  );
  for (const field of ["employeeCount", "sizeRange", "description"]) {
    assert.deepEqual(company.fieldProvenance[field], stamp, field);
  }
  const read = await run(() => getCompany(company.id));
  assert.deepEqual([read.employeeCount, read.sizeRange], [1234, "1234"]);
});

test("a size range given with the count is kept as given; a later count alone writes its text over an older range; an older one changes nothing", async () => {
  const both = { ...base, employeeCount: 40, sizeRange: "11-50" };
  const first = await run(() =>
    upsertCompany({ source: "linkedin", provider: "unipile", company: both }),
  );
  assert.deepEqual([first.company.employeeCount, first.company.sizeRange], [40, "11-50"]);
  const later = { ...base, employeeCount: 61, fetchedAt: new Date("2026-11-14T08:00:00Z") };
  const counted = await run(() =>
    upsertCompany({ source: "data_vendor", provider: "pdl", company: later }),
  );
  assert.deepEqual([counted.company.employeeCount, counted.company.sizeRange], [61, "61"]);
  const older = { ...base, employeeCount: 5, fetchedAt: new Date("2026-11-01T08:00:00Z") };
  const kept = await run(() =>
    upsertCompany({ source: "web_search", provider: "brave", company: older }),
  );
  assert.deepEqual([kept.company.employeeCount, kept.company.sizeRange], [61, "61"]);
});

test("a count below 1, not whole or past the column, or a description over 2,000 characters, is contacts_input_invalid naming it, and nothing is written; the migration's CHECKs refuse the same in the table", async () => {
  const refused = [
    [{ employeeCount: 0 }, "company.employeeCount"],
    [{ employeeCount: 1.5 }, "company.employeeCount"],
    [{ employeeCount: 2_147_483_648 }, "company.employeeCount"],
    [{ description: "x".repeat(COMPANY_DESCRIPTION_MAX + 1) }, "company.description"],
  ] as const;
  for (const [given, field] of refused) {
    await assert.rejects(
      run(() =>
        upsertCompany({
          source: "open_data",
          provider: "wikidata",
          company: { ...base, ...given },
        }),
      ),
      fails("contacts_input_invalid", [field]),
      field,
    );
  }
  const longest = "x".repeat(COMPANY_DESCRIPTION_MAX);
  const { company } = await run(() =>
    upsertCompany({
      source: "open_data",
      provider: "wikidata",
      company: { ...base, description: longest },
    }),
  );
  assert.equal(company.description?.length, COMPANY_DESCRIPTION_MAX);
  assert.equal(company.employeeCount, null);

  const owner = asRole("owner");
  const check = (constraint: string) => (error: unknown) => String(error).includes(constraint);
  await assert.rejects(
    owner.$executeRaw`UPDATE workspace_companies SET employee_count = 0 WHERE id = ${company.id}`,
    check("workspace_companies_employee_count"),
  );
  await assert.rejects(
    owner.$executeRaw`UPDATE workspace_companies SET description = ${`${longest}x`} WHERE id = ${company.id}`,
    check("workspace_companies_description"),
  );
});

test("the name and the keys equal to the stored ones keep their provenance when another source brings them, and take the stamp again when the source that stamped them does; a new value takes the new stamp", async () => {
  const imported = { source: "import", provider: "csv", at: fetchedAt.toISOString() };
  await run(() => upsertCompany({ source: "import", provider: "csv", company: base }));
  const at = new Date("2026-11-14T08:00:00Z");
  const vendor = { source: "data_vendor", provider: "pdl", at: at.toISOString() };
  const { company } = await run(() =>
    upsertCompany({
      source: "data_vendor",
      provider: "pdl",
      company: { ...base, industry: "Software", fetchedAt: at },
    }),
  );
  const stamps = (fields: string[]) => fields.map((field) => company.fieldProvenance[field]);
  assert.deepEqual(stamps(["name", "domain", "industry"]), [imported, imported, vendor]);
  const again = new Date("2026-11-15T08:00:00Z");
  const restamped = await run(() =>
    upsertCompany({
      source: "import",
      provider: "csv",
      company: { ...base, name: "Blue Harbor Labs Ltd", fetchedAt: again },
    }),
  );
  const csv = { ...imported, at: again.toISOString() };
  assert.equal(restamped.company.name, "Blue Harbor Labs Ltd");
  assert.deepEqual(
    ["name", "domain", "industry"].map((field) => restamped.company.fieldProvenance[field]),
    [csv, csv, vendor],
  );
});

// The company index (gamma-rf-010), on real workspaces: their organization is the sharing group.
const app = asRole("app");
const owner = asRole("owner");
useTenancyClient(app);
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const page = "https://linkedin.com/company/blue-harbor-labs";
const name = "Blue Harbor Labs";
const day = (n: number) => new Date(Date.UTC(2026, 10, n, 8));
const stampOf = (source: string, provider: string, n: number) => ({
  source,
  provider,
  at: day(n).toISOString(),
});
/** A row as the deploy found it: written before the link, its facts on its own columns. */
const oldRow = (workspaceId: string, row: Record<string, unknown>) =>
  app.workspaceCompany.create({
    data: { id: newId(ids.workspace_company), workspaceId, name, fieldProvenance: {}, ...row },
  });
const sharedRows = () => owner.sharedCompany.findMany({ orderBy: { createdAt: "asc" } });
const groupRow = (sharingGroupId: string, companyId: string) =>
  owner.groupCompany.findUnique({
    where: { sharingGroupId_companyId: { sharingGroupId, companyId } },
  });

test("the link: a row links to the shared company with its page, else with its domain, else to one made with its page and no stamp; its facts and keys go where their stamps put them, the link's key to the group's row; its own columns stay; a link never changes", async () => {
  const [a, b] = await createTwoWorkspaces();
  const provenance = {
    name: stampOf("linkedin", "unipile", 1),
    linkedinUrl: stampOf("linkedin", "unipile", 1),
    domain: stampOf("open_data", "wikidata", 2),
    industry: stampOf("open_data", "wikidata", 2),
    sizeRange: stampOf("linkedin", "unipile", 1),
    country: stampOf("website", "site", 3),
    description: stampOf("import", "csv", 4),
  };
  const facts = { industry: "Software", sizeRange: "11-50", country: "DE", description: "Tools." };
  const ours = await oldRow(a.workspace.id, {
    linkedinUrl: page,
    domain: "blueharbor.example",
    ...facts,
    fieldProvenance: provenance,
  });
  const before = await inRun(a.workspace.id, () => getCompany(ours.id));
  assert.deepEqual(await inRun(a.workspace.id, () => refreshCompany(ours.id)), before);
  const [shared, ...more] = await sharedRows();
  assert.ok(shared !== undefined && more.length === 0);
  assert.deepEqual(
    [shared.linkedinUrl, shared.domain, shared.industry, shared.country, shared.sizeRange],
    [page, "blueharbor.example", "Software", "DE", null],
  );
  const { domain, industry, country } = provenance;
  assert.deepEqual(shared.fieldProvenance, { domain, industry, country }, "the page has no stamp");
  const group = await groupRow(a.organization.id, shared.id);
  assert.deepEqual(
    [group?.sizeRange, group?.description, group?.linkedinUrl, group?.domain],
    ["11-50", "Tools.", page, null],
  );
  const groupStamps = group?.fieldProvenance as Record<string, unknown> | undefined;
  assert.deepEqual(groupStamps?.linkedinUrl, provenance.linkedinUrl, "the link's key, stamped");
  const stored = await owner.workspaceCompany.findUniqueOrThrow({ where: { id: ours.id } });
  assert.deepEqual({ ...stored, companyId: null }, { ...ours, companyId: null }, "its own columns");
  assert.equal(stored.companyId, shared.id);

  // Another organization's row with the domain alone links to it, and reads the shared facts only.
  const theirs = await oldRow(b.workspace.id, {
    domain: "blueharbor.example",
    fieldProvenance: { domain: stampOf("import", "csv", 5) },
  });
  const read = await inRun(b.workspace.id, () => refreshCompany(theirs.id));
  assert.deepEqual(
    [read.industry, read.country, read.sizeRange, read.description],
    ["Software", "DE", null, null],
  );
  // The page that made the shared company carries no stamp there: A's LinkedIn read stays in A.
  assert.equal(read.linkedinUrl, null, "the page that made the shared company, never copied down");
  // A new page for our row keeps the link; the page goes to the group's row.
  const moved = "https://linkedin.com/company/blue-harbor";
  await inRun(a.workspace.id, () =>
    upsertCompany({
      source: "linkedin",
      provider: "unipile",
      company: { name, domain: "blueharbor.example", linkedinUrl: moved, fetchedAt: day(6) },
    }),
  );
  const after = await owner.workspaceCompany.findUniqueOrThrow({ where: { id: ours.id } });
  assert.deepEqual([after.linkedinUrl, after.companyId], [moved, shared.id]);
  assert.equal((await groupRow(a.organization.id, shared.id))?.linkedinUrl, moved);
});

test("routing: a fact goes to the shared company when its class is in the setting, else to the group's row; a key the row gains goes to the shared company when that has none and no other holds it, else to the group's row", async () => {
  const [a, b] = await createTwoWorkspaces();
  const write = (workspaceId: string, source: string, provider: string, company: object) =>
    inRun(workspaceId, () =>
      upsertCompany({
        source: source as "open_data",
        provider,
        company: { name, linkedinUrl: page, ...company },
      }),
    );
  await write(a.workspace.id, "linkedin", "unipile", { fetchedAt: day(1) });
  await write(a.workspace.id, "web_search", "brave", { industry: "Logistics", fetchedAt: day(2) });
  useSharedFactSources(["open_data", "web_search"]);
  await write(a.workspace.id, "web_search", "brave", { description: "Ships.", fetchedAt: day(3) });
  useSharedFactSources(undefined);
  const { company } = await write(a.workspace.id, "open_data", "wikidata", {
    domain: "blueharbor.example",
    providerId: "Q42",
    fetchedAt: day(4),
  });
  assert.deepEqual(company, await inRun(a.workspace.id, () => getCompany(company.id)));
  const [shared] = await sharedRows();
  assert.deepEqual(
    [shared?.industry, shared?.description, shared?.domain, shared?.providerRefs],
    [null, "Ships.", "blueharbor.example", { wikidata: "Q42" }],
  );
  const group = await groupRow(a.organization.id, shared?.id ?? "");
  assert.deepEqual([group?.industry, group?.domain], ["Logistics", null]);
  assert.deepEqual(
    [company.industry, company.description, company.domain, company.providerRefs],
    ["Logistics", "Ships.", "blueharbor.example", { wikidata: "Q42" }],
  );
  assert.deepEqual(company.fieldProvenance.industry, stampOf("web_search", "brave", 2));

  // Another company, linked by its own page, gains a domain another shared company holds: the
  // group's row keeps it.
  const other = "https://linkedin.com/company/blue-harbor-group";
  for (const [source, company] of [
    ["linkedin", { linkedinUrl: other, fetchedAt: day(5) }],
    ["open_data", { linkedinUrl: other, domain: "blueharbor.example", fetchedAt: day(6) }],
  ] as const) {
    await inRun(b.workspace.id, () =>
      upsertCompany({ source, provider: "wikidata", company: { name, ...company } }),
    );
  }
  const made = (await sharedRows()).find((row) => row.linkedinUrl === other);
  assert.equal(made?.domain, null);
  const theirs = await groupRow(b.organization.id, made?.id ?? "");
  assert.equal(theirs?.domain, "blueharbor.example");
});

test("one person: a write with a headcount of 1 puts every fact on the group's row, and so does a later write while the company reads so; a size whose upper bound is 1 counts", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const solo = (company: object, n: number) =>
    inRun(ws, () =>
      upsertCompany({
        source: "open_data",
        provider: "wikidata",
        company: { name, linkedinUrl: page, ...company, fetchedAt: day(n) },
      }),
    );
  await solo({ employeeCount: 1, industry: "Consulting", country: "FR" }, 1);
  await solo({ description: "Freelance data work." }, 2);
  const [shared] = await sharedRows();
  assert.deepEqual(
    [shared?.employeeCount, shared?.sizeRange, shared?.industry, shared?.description],
    [null, null, null, null],
  );
  assert.deepEqual(shared?.fieldProvenance, {});
  const group = await groupRow(a.organization.id, shared?.id ?? "");
  assert.deepEqual(
    [group?.employeeCount, group?.sizeRange, group?.industry, group?.country, group?.description],
    [1, "1", "Consulting", "FR", "Freelance data work."],
  );
  await inRun(ws, () =>
    upsertCompany({
      source: "open_data",
      provider: "wikidata",
      company: { name, domain: "solo.example", sizeRange: "0-1", industry: "Design" },
    }),
  );
  const zeroToOne = (await sharedRows()).find((row) => row.domain === "solo.example");
  assert.equal(zeroToOne?.industry, null);
  assert.equal((await groupRow(a.organization.id, zeroToOne?.id ?? ""))?.industry, "Design");
  const sizes = ["1", "0-1", "1 employee", "1-10", "2-10 employees", "10,001+", "Self-employed"];
  assert.deepEqual(
    sizes.map((sizeRange) => readsOnePerson({ sizeRange })),
    [true, true, true, false, false, false, false],
  );
  assert.deepEqual(
    [readsOnePerson({ employeeCount: 1 }), readsOnePerson({ employeeCount: 2 })],
    [true, false],
  );
});

test("the race: two runs that make the same shared company at once leave one row and both link to it, and two inserts at once leave one row (ON CONFLICT DO NOTHING)", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ours = await oldRow(a.workspace.id, { linkedinUrl: page });
  const theirs = await oldRow(b.workspace.id, { linkedinUrl: page });
  await Promise.all([
    inRun(a.workspace.id, () => refreshCompany(ours.id)),
    inRun(b.workspace.id, () => refreshCompany(theirs.id)),
  ]);
  const shared = await sharedRows();
  assert.equal(shared.length, 1);
  const links = await owner.workspaceCompany.findMany({ select: { companyId: true } });
  assert.deepEqual(
    links.map((row) => row.companyId),
    [shared[0]?.id, shared[0]?.id],
  );

  const other = "https://linkedin.com/company/blue-harbor-group";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inserted = () => {};
  const first = inRun(a.workspace.id, async () => {
    const id = await makeShared("linkedinUrl", other);
    inserted();
    await held;
    return id;
  });
  await new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const second = inRun(b.workspace.id, () => makeShared("linkedinUrl", other));
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.ok(one !== null && one === two);
  assert.equal((await sharedRows()).filter((row) => row.linkedinUrl === other).length, 1);
});

test("the CHECK on companies refuses a stamp from linkedin, import, member or ai_inferred, or one without a source, whoever writes it: tried with the owner's client; a shared class's stamp passes", async () => {
  const insert = (id: string, provenance: object) =>
    owner.$executeRaw`
      INSERT INTO companies (id, domain, field_provenance, updated_at)
      VALUES (${id}, ${`${id}.example`}, ${JSON.stringify(provenance)}::jsonb, now())`;
  const refused = (error: unknown) => String(error).includes("companies_field_provenance_source");
  const at = day(1).toISOString();
  for (const source of ["linkedin", "import", "member", "ai_inferred"]) {
    const stamps = { domain: stampOf("open_data", "wikidata", 1), industry: { source, at } };
    await assert.rejects(insert(`com_${source}`, stamps), refused, source);
  }
  await assert.rejects(insert("com_unstamped", { industry: { provider: "x", at } }), refused);
  for (const source of ["open_data", "website", "web_search", "data_vendor"]) {
    assert.equal(await insert(`com_${source}`, { industry: { source, provider: "x", at } }), 1);
  }
  const keyless = owner.$executeRaw`
    INSERT INTO companies (id, field_provenance, updated_at) VALUES ('com_keyless', '{}', now())`;
  await assert.rejects(keyless, (error: unknown) => String(error).includes("companies_key"));
});
