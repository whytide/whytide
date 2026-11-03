// tenancy's domain (alpha-p3-010): the slug rule, then the commands end to end on the worktree's
// database, in this file's schema, through the module's own client. GET /v1/me's test is the api
// host's (core/apps/api/tests/me.test.ts): a module never imports a host, its tests included.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { isAppError } from "@whytide/platform";
import {
  addMember,
  addOwner,
  bootstrapOrganization,
  createWorkspace,
  disableUser,
  findOrganizationBySlug,
  findUser,
  findUserByEmail,
  findWorkspace,
  listMemberships,
  listWorkspaceIds,
  resolveMembership,
  upsertUser,
} from "../domain/commands.ts";
import { isSlug } from "../domain/rules.ts";
import { createTwoWorkspaces, createUser, useTenancyClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));

const fails = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
const counts = async () =>
  asRole("app").$queryRaw<{ organizations: number; workspaces: number; memberships: number }[]>`
    SELECT (SELECT count(*) FROM organizations)::int AS organizations,
      (SELECT count(*) FROM workspaces)::int AS workspaces,
      (SELECT count(*) FROM memberships)::int AS memberships`;

test("a slug: 2 to 40 lowercase letters, digits and single dashes, starting with a letter", () => {
  for (const slug of ["main", "a1", "sales-emea-2", "x".repeat(40)]) assert.ok(isSlug(slug), slug);
  const invalid = ["", "a", "Main", "1st", "-main", "main-", "ma--in", "ma_in", "x".repeat(41)];
  for (const slug of invalid) assert.ok(!isSlug(slug), slug);
});

test("upsertUser keeps one user per email, lowercased, and the table refuses another case", async () => {
  const ada = await upsertUser({ email: " Ada@Example.com" });
  const again = await upsertUser({ email: "ADA@example.com", displayName: "Ada" });
  assert.deepEqual([again.id, again.email, again.displayName], [ada.id, "ada@example.com", "Ada"]);
  const upper = asRole("app").$executeRaw`
    INSERT INTO users (id, email) VALUES ('usr_upper', 'Bob@example.com')`;
  assert.equal(await sqlstate(upper), "23514");
});

test("bootstrapOrganization writes the three rows in one transaction; the slug again is organization_exists and writes nothing", async () => {
  const owner = await upsertUser({ email: "owner@example.com" });
  const other = await upsertUser({ email: "other@example.com" });
  const made = await bootstrapOrganization({
    name: "Acme",
    workspaceSlug: "acme",
    ownerUserId: owner.id,
  });
  const { organization, workspace, membership } = made;
  assert.deepEqual(
    [organization.slug, workspace.slug, workspace.organizationId, workspace.name],
    ["acme", "acme", organization.id, "Acme"],
  );
  assert.deepEqual(
    [membership.workspaceId, membership.userId, membership.role],
    [workspace.id, owner.id, "Owner"],
  );
  // xmin is the id of the transaction that wrote a row: one for the three rows.
  const [row] = await asRole("app").$queryRaw<{ writers: number }[]>`
    SELECT count(DISTINCT xmin::text)::int AS writers FROM (SELECT xmin FROM organizations
      UNION ALL SELECT xmin FROM workspaces UNION ALL SELECT xmin FROM memberships) made`;
  assert.equal(row?.writers, 1);

  const again = { name: "Other", workspaceSlug: "acme", ownerUserId: other.id };
  await assert.rejects(bootstrapOrganization(again), fails("organization_exists"));
  assert.deepEqual(await counts(), [{ organizations: 1, workspaces: 1, memberships: 1 }]);

  // Two at once with one slug: the one that loses the race between the check and the insert too.
  const race = (ownerUserId: string) =>
    bootstrapOrganization({ name: "Race", workspaceSlug: "race", ownerUserId });
  const settled = await Promise.allSettled([race(owner.id), race(other.id)]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const lost = settled.find((result) => result.status === "rejected");
  assert.ok(fails("organization_exists")(lost?.reason), String(lost?.reason));
  assert.deepEqual(await counts(), [{ organizations: 2, workspaces: 2, memberships: 2 }]);

  const invalid = { name: "Acme", workspaceSlug: "Not a slug", ownerUserId: owner.id };
  await assert.rejects(bootstrapOrganization(invalid), (error: unknown) => {
    assert.ok(fails("tenancy_input_invalid")(error));
    assert.deepEqual(isAppError(error) && error.details, { fields: ["workspaceSlug"] });
    return true;
  });
});

test("createWorkspace writes the workspace and the Owner membership in one transaction; a slug taken in the organization is workspace_exists and writes nothing; another organization may take it", async () => {
  const [a, b] = await createTwoWorkspaces();
  const input = { organizationId: a.organization.id, name: "Sales", slug: "sales" };
  const { workspace, membership } = await createWorkspace({ ...input, ownerUserId: a.user.id });
  assert.deepEqual(
    [workspace.organizationId, workspace.name, workspace.slug],
    [a.organization.id, "Sales", "sales"],
  );
  assert.deepEqual(
    [membership.workspaceId, membership.userId, membership.role],
    [workspace.id, a.user.id, "Owner"],
  );
  // xmin is the id of the transaction that wrote a row: one for both rows.
  const [row] = await asRole("app").$queryRaw<{ same: boolean }[]>`
    SELECT w.xmin = m.xmin AS same FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
    WHERE w.id = ${workspace.id}`;
  assert.equal(row?.same, true);

  const before = await counts();
  const again = { ...input, name: "Other", ownerUserId: b.user.id };
  await assert.rejects(createWorkspace(again), fails("workspace_exists"));
  const unknownOrganization = { ...again, organizationId: "org_missing", slug: "new" };
  await assert.rejects(createWorkspace(unknownOrganization), fails("organization_not_found"));
  const unknownUser = { ...again, ownerUserId: "usr_missing", slug: "new" };
  await assert.rejects(createWorkspace(unknownUser), fails("user_not_found"));
  assert.deepEqual(await counts(), before);

  const elsewhere = await createWorkspace({ ...again, organizationId: b.organization.id });
  assert.deepEqual(
    [elsewhere.workspace.organizationId, elsewhere.workspace.slug],
    [b.organization.id, "sales"],
  );
  assert.deepEqual(await findOrganizationBySlug(a.organization.slug), a.organization);
  assert.equal(await findOrganizationBySlug("nowhere"), null);
  await assert.rejects(findOrganizationBySlug("Not a slug"), fails("tenancy_input_invalid"));
});

test("two createWorkspace calls at once with one slug make one workspace; the other is workspace_exists", async () => {
  const [a, b] = await createTwoWorkspaces();
  const race = (ownerUserId: string) =>
    createWorkspace({ organizationId: a.organization.id, name: "Race", slug: "race", ownerUserId });
  const settled = await Promise.allSettled([race(a.user.id), race(b.user.id)]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  const lost = settled.find((result) => result.status === "rejected");
  assert.ok(fails("workspace_exists")(lost?.reason), String(lost?.reason));
  assert.deepEqual(await counts(), [{ organizations: 2, workspaces: 3, memberships: 3 }]);
});

test("resolveMembership by id and by slug, null without a membership; listMemberships lists the user's own", async () => {
  const [a, b] = await createTwoWorkspaces();
  const joined = await addOwner({ userId: a.user.id, workspaceId: b.workspace.id });
  const stranger = await createUser();
  const resolve = (userId: string, workspaceIdOrSlug: string) =>
    resolveMembership({ userId, workspaceIdOrSlug });

  assert.deepEqual(await resolve(a.user.id, a.workspace.id), a.membership);
  assert.deepEqual(await resolve(a.user.id, b.workspace.slug), joined);
  assert.equal(await resolve(b.user.id, a.workspace.id), null);
  assert.equal(await resolve(b.user.id, a.workspace.slug), null);
  assert.equal(await resolve(stranger.id, b.workspace.slug), null);

  const listing = (tenant: typeof a, membershipId: string) => ({
    membershipId,
    workspaceId: tenant.workspace.id,
    slug: tenant.workspace.slug,
    name: tenant.workspace.name,
    organizationId: tenant.organization.id,
    organizationName: tenant.organization.name,
    role: "Owner",
  });
  const both = [listing(a, a.membership.id), listing(b, joined.id)];
  assert.deepEqual(await listMemberships(a.user.id), both);
  assert.deepEqual(await listMemberships(b.user.id), [listing(b, b.membership.id)]);
  assert.deepEqual(await listMemberships(stranger.id), []);
});

test("an undefined or empty user id is refused, never read as no filter", async () => {
  await createTwoWorkspaces();
  const refused = fails("tenancy_input_invalid");
  await assert.rejects(listMemberships(undefined as unknown as string), refused);
  await assert.rejects(listMemberships(""), refused);
  await assert.rejects(resolveMembership({ userId: "", workspaceIdOrSlug: "main" }), refused);
});

test("addMember adds the role once and keeps a membership there is; an unknown workspace or user is refused", async () => {
  const [a, b] = await createTwoWorkspaces();
  const add = (userId: string, workspaceId: string, role: "Admin" | "Member") =>
    addMember({ userId, workspaceId, role });
  const member = await add(a.user.id, b.workspace.id, "Member");
  const { userId, workspaceId, role } = member;
  assert.deepEqual([userId, workspaceId, role], [a.user.id, b.workspace.id, "Member"]);
  assert.deepEqual(await add(a.user.id, b.workspace.id, "Admin"), member);
  assert.deepEqual(await addOwner({ userId: a.user.id, workspaceId: b.workspace.id }), member);
  await assert.rejects(add(a.user.id, "wsp_missing", "Member"), fails("workspace_not_found"));
  await assert.rejects(add("usr_missing", a.workspace.id, "Member"), fails("user_not_found"));
});

test("findUserByEmail reads the address lowercased and creates nothing; findUser and findWorkspace read by id", async () => {
  const ada = await upsertUser({ email: "ada@example.com" });
  assert.deepEqual(await findUserByEmail(" ADA@Example.com"), ada);
  assert.equal(await findUserByEmail("bob@example.com"), null);
  await assert.rejects(findUserByEmail("not an email"), fails("tenancy_input_invalid"));
  const [row] = await asRole("app").$queryRaw<{ users: number }[]>`
    SELECT count(*)::int AS users FROM users`;
  assert.equal(row?.users, 1);
  assert.deepEqual(await findUser(ada.id), ada);
  const [a] = await createTwoWorkspaces();
  assert.deepEqual(await findWorkspace(a.workspace.id), a.workspace);
  assert.equal(await findWorkspace("wsp_missing"), null);
});

test("disableUser sets disabled_at once and keeps the first time; an unknown user is refused", async () => {
  const ada = await upsertUser({ email: "ada@example.com" });
  const disabled = await disableUser(ada.id);
  assert.ok(disabled.disabledAt instanceof Date);
  assert.deepEqual(await disableUser(ada.id), disabled);
  await assert.rejects(disableUser("usr_missing"), fails("user_not_found"));
});

test("listWorkspaceIds lists every workspace's id, by id, and nothing else", async () => {
  const [a, b] = await createTwoWorkspaces();
  assert.deepEqual(await listWorkspaceIds(), [a.workspace.id, b.workspace.id].sort());
});
