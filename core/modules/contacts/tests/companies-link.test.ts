// `pnpm -F contacts companies:link` (gamma-rf-010; cli/companies-link.ts) on the worktree's
// database: the rows the deploy found read their own columns until the script links them; then every
// row of every workspace is linked and each old fact reads as before, with its stamp, beside what the
// shared company brings from another organization's row of the same company; a second run changes
// nothing; it prints counts only.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { runCompaniesLink } from "../cli/companies-link.ts";
import { getCompany } from "../domain/companies.ts";
import { ids } from "../ids.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const app = asRole("app");
const owner = asRole("owner");
useTenancyClient(app);
const principal = servicePrincipal("contacts_test");
const stamp = (source: string, provider: string, day: number) => ({
  source,
  provider,
  at: new Date(Date.UTC(2026, 9, day, 8)).toISOString(),
});

/** A row as the deploy found it: written before the link, its facts on its own columns. */
function oldRow(workspaceId: string, slug: string, row: Record<string, unknown>) {
  const linkedinUrl = `https://linkedin.com/company/${slug}`;
  const provenance = {
    name: stamp("linkedin", "unipile", 1),
    linkedinUrl: stamp("linkedin", "unipile", 1),
  };
  const { fieldProvenance, ...rest } = row as { fieldProvenance?: object };
  return app.workspaceCompany.create({
    data: {
      id: newId(ids.workspace_company),
      workspaceId,
      name: slug,
      linkedinUrl,
      fieldProvenance: { ...provenance, ...fieldProvenance },
      ...rest,
    },
  });
}

test("the rows read their own columns until the script links them; then every row is linked and each old fact reads as before; a second run changes nothing; counts only", async () => {
  const [{ workspace: a }, { workspace: b }] = await createTwoWorkspaces();
  const rows = [
    await oldRow(a.id, "north-labs", {
      industry: "Software",
      sizeRange: "11-50",
      fieldProvenance: {
        industry: stamp("open_data", "wikidata", 2),
        sizeRange: stamp("linkedin", "unipile", 1),
      },
    }),
    await oldRow(a.id, "south-labs", {
      domain: "south.example",
      description: "Logistics tools.",
      providerRefs: { pdl: "pdl-1" },
      fieldProvenance: {
        domain: stamp("import", "csv", 3),
        description: stamp("data_vendor", "pdl", 4),
        providerRefs: stamp("data_vendor", "pdl", 4),
      },
    }),
    await oldRow(b.id, "north-labs", {
      country: "DE",
      employeeCount: 40,
      fieldProvenance: {
        country: stamp("website", "site", 5),
        employeeCount: stamp("ai_inferred", "model", 5),
      },
    }),
  ];
  const read = () =>
    Promise.all(
      rows.map(({ id, workspaceId }) =>
        withTenant({ workspaceId, principal }, () => getCompany(id), { client: app }),
      ),
    );
  const before = await read();
  const lines: string[] = [];
  assert.equal(await runCompaniesLink([], (line) => lines.push(line), app), 0);
  assert.deepEqual(lines, [
    "companies_linked: 3 linked, 0 without a key, 0 without a group of 3 read in 2 workspaces",
  ]);
  const linked = await owner.workspaceCompany.findMany({ orderBy: { id: "asc" } });
  assert.ok(linked.every((row) => row.companyId !== null));
  const north = linked.filter(
    (row) => row.linkedinUrl === "https://linkedin.com/company/north-labs",
  );
  assert.equal(new Set(north.map((row) => row.companyId)).size, 1, "one shared company per page");
  const after = await read();
  for (const [index, was] of before.entries()) {
    const now = after[index];
    assert.deepEqual([now?.id, now?.name, now?.updatedAt], [was.id, was.name, was.updatedAt]);
    for (const [field, value] of Object.entries(was)) {
      if (value === null || ["fieldProvenance", "createdAt", "updatedAt"].includes(field)) continue;
      const stamped = [now?.[field as keyof typeof was], now?.fieldProvenance[field]];
      assert.deepEqual(stamped, [value, was.fieldProvenance[field]], `${index}: ${field}`);
    }
  }
  // The two organizations' rows of north-labs share the shared classes' facts only.
  assert.deepEqual([after[2]?.industry, after[0]?.country], ["Software", "DE"]);
  assert.deepEqual([after[2]?.sizeRange, after[0]?.employeeCount], [null, null]);

  const state = async () => [
    await owner.sharedCompany.findMany({ orderBy: { id: "asc" } }),
    await owner.groupCompany.findMany({
      orderBy: [{ sharingGroupId: "asc" }, { companyId: "asc" }],
    }),
    await owner.workspaceCompany.findMany({ orderBy: { id: "asc" } }),
  ];
  const once = await state();
  lines.length = 0;
  assert.equal(await runCompaniesLink(["--workspace", a.id], (line) => lines.push(line), app), 0);
  assert.deepEqual(lines, [
    "companies_linked: 0 linked, 0 without a key, 0 without a group of 0 read in 1 workspaces",
  ]);
  assert.deepEqual(await state(), once);
  assert.equal(await runCompaniesLink(["--nope"], (line) => lines.push(line), app), 2);
});
