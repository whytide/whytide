// The first sign-in on an empty database (README.md "The invite command"): `pnpm invite` makes the
// organization and the workspace from ORGANIZATION_NAME and WORKSPACE_SLUG, the first email their
// Owner; every email after joins that workspace as Owner at its first sign-in, and no second
// organization is made; two first sign-ins of one email at once make one user. On this file's own
// schema, which starts with no organization.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { listMemberships, settings } from "@whytide/tenancy";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { runInvite } from "../cli/invite.ts";
import { findOrCreateByEmail } from "../domain/sign-in.ts";
import { useIdentityClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));

test("the first invite bootstraps the organization and the workspace; the second user joins it as Owner", async () => {
  const lines: string[] = [];
  assert.equal(await runInvite(["first@example.test"], (line) => lines.push(line)), 0);
  assert.equal(await runInvite(["second@example.test"], (line) => lines.push(line)), 0);
  assert.deepEqual(
    lines.map((line) => line.split(":")[0]),
    ["organization_created", "invite_created", "invite_created"],
  );
  const organizations = await asRole("app").organization.findMany({ select: { name: true } });
  assert.deepEqual(organizations, [{ name: settings.ORGANIZATION_NAME }]);
  const workspaces = [];
  for (const email of ["first@example.test", "second@example.test"]) {
    const { id } = await findOrCreateByEmail(email); // the first sign-in
    const own = (await listMemberships(id)).map(({ slug, role }) => ({ slug, role }));
    workspaces.push(...own);
  }
  const owner = { slug: settings.WORKSPACE_SLUG, role: "Owner" };
  assert.deepEqual(workspaces, [owner, owner]);
  // With an organization, an invite to a slug no workspace has makes none.
  assert.equal(await runInvite(["third@example.test", "--workspace", "other"], () => {}), 1);
  assert.equal(await asRole("app").organization.count(), 1);
});

test("two first sign-ins of one email at once make one user and one membership", async () => {
  for (const email of ["one@example.test", "two@example.test", "three@example.test"]) {
    assert.equal(await runInvite([email], () => {}), 0);
    const [a, b] = await Promise.all([findOrCreateByEmail(email), findOrCreateByEmail(email)]);
    assert.equal(a.id, b.id);
    assert.deepEqual(
      (await listMemberships(a.id)).map(({ role }) => role),
      ["Owner"],
    );
  }
});
