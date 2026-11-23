// identity's command and sign-in rule (alpha-p3-030), on the worktree's database in this file's
// schema: `pnpm invite` run as its bin runs it, allowSignIn, and the email rule. The guard and the
// first sign-in are tested through the api: core/apps/api/tests/guard.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { bootstrapOrganization, settings } from "@whytide/tenancy";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { runInvite } from "../cli/invite.ts";
import { createInvite } from "../domain/invites.ts";
import { normalizeEmail } from "../domain/rules.ts";
import { allowSignIn, disable, findOrCreateByEmail } from "../domain/sign-in.ts";
import { useIdentityClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
/** An invite as `pnpm invite` makes one: Owner, by no user. */
const byCommand = { role: "Owner", invitedBy: null } as const;

/** The command's exit code and lines. */
async function invite(...args: string[]) {
  const lines: string[] = [];
  const code = await runInvite(args, (line) => lines.push(line));
  return { code, lines };
}

test("the email rule: trimmed and lowercased, 254 characters at most; anything else is null", () => {
  assert.equal(normalizeEmail("  Ada@Example.TEST "), "ada@example.test");
  for (const bad of ["", "ada", "a@b@example.test", `${"a".repeat(250)}@x.test`, 42]) {
    assert.equal(normalizeEmail(bad), null, String(bad));
  }
});

test("pnpm invite: one invite, lowercased, in WORKSPACE_SLUG; a second run reports it and exits 0", async () => {
  const owner = await createUser();
  const workspaceSlug = settings.WORKSPACE_SLUG;
  const made = await bootstrapOrganization({ name: "Acme", workspaceSlug, ownerUserId: owner.id });
  const first = await invite("A@Example.test");
  assert.equal(first.code, 0);
  assert.match(
    first.lines[0] ?? "",
    /^invite_created: a@example\.test may sign in to wsp_\w+ at .*\/sign-in$/,
  );
  const second = await invite("a@example.test");
  assert.equal(second.code, 0);
  assert.match(second.lines[0] ?? "", /^invite_exists: a@example\.test is invited/);
  const select = { workspaceId: true, email: true, role: true, invitedBy: true, acceptedAt: true };
  const row = { workspaceId: made.workspace.id, email: "a@example.test", role: "Owner" };
  const rows = await asRole("app").invite.findMany({ select });
  assert.deepEqual(rows, [{ ...row, invitedBy: null, acceptedAt: null }]);
  // --workspace takes an id too; a slug no workspace has, or no email, is refused.
  const [other] = await createTwoWorkspaces();
  assert.equal((await invite("a@example.test", "--workspace", other.workspace.id)).code, 0);
  assert.equal((await invite("a@example.test", "--workspace", "nowhere")).code, 1);
  assert.equal((await invite("--workspace", other.workspace.id)).code, 2);
  assert.equal(await asRole("app").invite.count(), 2);
});

test("allowSignIn: an invited email in any case, an existing member; nobody else, nor a disabled user, and it creates no user", async () => {
  const [a, b] = await createTwoWorkspaces();
  await createInvite({ ...byCommand, workspaceId: a.workspace.id, email: "invited@example.test" });
  assert.equal(await allowSignIn("INVITED@Example.Test"), true);
  assert.equal(await allowSignIn(a.user.email), true);
  assert.equal(await allowSignIn("stranger@example.test"), false);
  assert.equal(await allowSignIn("not an email"), false);
  assert.equal(await asRole("app").user.count(), 2);
  // A disabled member with a pending invite: refused, given its disabledAt, the invite left pending.
  await createInvite({ ...byCommand, workspaceId: b.workspace.id, email: a.user.email });
  await disable(a.user.id);
  assert.equal(await allowSignIn(a.user.email), false);
  assert.ok((await findOrCreateByEmail(a.user.email)).disabledAt instanceof Date);
  const pending = await asRole("app").invite.findFirst({ where: { email: a.user.email } });
  assert.equal(pending?.acceptedAt, null);
});
