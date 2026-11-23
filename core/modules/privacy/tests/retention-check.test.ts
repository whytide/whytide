// `pnpm retention:check` on the worktree's database (README.md "The 30-day rule"; gamma-p7-010): the
// 30-day rule's candidates as of a fixed instant, a line per workspace, every workspace or the one
// named by its id or slug, then the total; it writes nothing and prints no person. A usage error
// exits 2, an unknown workspace 1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordTouch, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { runRetentionCheck } from "../cli/retention.ts";
import { useClient } from "../domain/client.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useClient(asRole("app"));
useTenancyClient(asRole("app"));

const principal = servicePrincipal("privacy_test");
/** The check's instant: its cutoff is 2026-10-02T03:15Z. */
const NOW = new Date("2026-11-01T03:15:00.000Z");
const OLD = new Date("2026-09-15T10:00:00.000Z");
const RECENT = new Date("2026-10-20T10:00:00.000Z");
const NAME = "Quillon";

/** A person of the workspace found at `found`, touched at `touched` if given; its URL's slug named. */
async function personIn(
  workspaceId: string,
  slug: string,
  options: { locationText?: string; found?: Date; touched?: Date } = {},
): Promise<void> {
  const id = await withTenant(
    { workspaceId, principal },
    async () => {
      const linkedinUrl = `https://linkedin.com/in/${slug}`;
      const profile = { linkedinUrl, firstName: NAME, locationText: options.locationText };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      if (options.touched) await recordTouch(person.id, options.touched);
      return person.id as string;
    },
    { client: asRole("app") },
  );
  const found = options.found ?? OLD;
  await asRole("owner").$executeRaw`UPDATE persons SET created_at = ${found} WHERE id = ${id}`;
}

/** Workspace A with three candidates among six persons, B with one. */
async function fixture() {
  const a = (await createOrganizationWithWorkspace()).workspace;
  const b = (await createOrganizationWithWorkspace()).workspace;
  await personIn(a.id, "a-gb-old", { locationText: "London, United Kingdom" });
  await personIn(a.id, "a-fr-old", { locationText: "Lyon, France" });
  await personIn(a.id, "a-nowhere-old");
  await personIn(a.id, "a-gb-recent", { locationText: "Leeds, England", found: RECENT });
  await personIn(a.id, "a-us-old", { locationText: "Austin, Texas, United States" });
  const touched = new Date("2026-10-01T09:00:00.000Z");
  await personIn(a.id, "a-gb-touched", { locationText: "Bristol, United Kingdom", touched });
  await personIn(b.id, "b-de-old", { locationText: "Berlin, Germany" });
  return { a, b };
}

/** Every row of every table of the test's schema, as JSON text, by table. */
async function everyRow(): Promise<Record<string, string[]>> {
  const owner = asRole("owner");
  const tables = await owner.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    const found = await owner.$queryRawUnsafe<{ row: string }[]>(
      `SELECT to_jsonb(t)::text AS row FROM "${name}" t ORDER BY 1`,
    );
    rows[name] = found.map(({ row }) => row);
  }
  return rows;
}

const check = async (args: string[]) => {
  const printed: string[] = [];
  const code = await runRetentionCheck(args, (line) => printed.push(line), NOW);
  return { code, printed };
};

test("the check prints every workspace's candidates and the total, writes nothing and prints no person", async () => {
  const { a, b } = await fixture();
  const before = await everyRow();
  const { code, printed } = await check([]);
  assert.equal(code, 0);
  const lines = [`retention_candidates: ${a.id} 3`, `retention_candidates: ${b.id} 1`].sort();
  assert.deepEqual(printed, [...lines, "retention_total: 4"]);
  assert.deepEqual(await everyRow(), before);
  for (const value of [NAME, "linkedin", "a-gb-old", "London"]) {
    assert.ok(!printed.join("\n").includes(value), `prints no ${value}`);
  }
});

test("the check counts the workspace named by its slug or its id alone", async () => {
  const { a, b } = await fixture();
  assert.deepEqual(await check(["--workspace", a.slug]), {
    code: 0,
    printed: [`retention_candidates: ${a.id} 3`, "retention_total: 3"],
  });
  assert.deepEqual(await check(["--workspace", b.id]), {
    code: 0,
    printed: [`retention_candidates: ${b.id} 1`, "retention_total: 1"],
  });
});

test("the check refuses a usage error with 2 and an unknown workspace with 1", async () => {
  await fixture();
  const usage = "usage: pnpm retention:check [--workspace <id or slug>]";
  for (const args of [["--workspace"], ["--bogus"], ["extra"], ["--workspace", "a", "b"]]) {
    assert.deepEqual(await check(args), { code: 2, printed: [usage] }, args.join(" "));
  }
  assert.deepEqual(await check(["--workspace", "wsp_unknown7"]), {
    code: 1,
    printed: ["workspace_not_found: no single workspace is wsp_unknown7"],
  });
  assert.deepEqual(await check(["--workspace", "no-such-slug"]), {
    code: 1,
    printed: ["workspace_not_found: no single workspace is no-such-slug"],
  });
  assert.deepEqual(await check(["--workspace", "Not A Slug"]), {
    code: 1,
    printed: ["tenancy_input_invalid"],
  });
});
