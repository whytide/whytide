// identity's Invites screen and Invitations page (gamma-p6-020; core/modules/identity/README.md
// "Invites"), in wsp_e2e_invites, this spec's alone, whose E2E_USERS are Owners
// (core/apps/api/tests/e2e-server.ts): an Owner invites a new email as Member, reads the mail's
// outcome, revokes the invite after the confirmation and sends it again; a user who already has an
// account, a member of wsp_e2e_invitations, accepts on /invitations and lands in the workspace. The
// invitee's sign-in through the mail and a Member's hint: identity's own sign-in.spec.ts, which
// reads Mailpit. Every text from its key.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import identity from "../../../modules/identity/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { E2E_EMAIL, expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_invites";
const SCREEN = `/w/${WORKSPACE}/invites`;
const messages: Record<string, string> = { ...identity, ...web };

/** The text of a key, its `{name}` placeholders filled; a key missing from the messages fails. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

const rowOf = (page: Page, email: string) =>
  page.getByRole("main").getByRole("listitem").filter({ hasText: email });
const badge = (page: Page, email: string, key: string) =>
  rowOf(page, email).getByText(say(key), { exact: true });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test("an Owner invites a new email as Member, revokes the invite after the confirmation and sends it again", async ({
  page,
  signInAs,
}) => {
  const email = `invitee-${randomUUID()}@example.test`;
  await signInAs();
  await page.goto(SCREEN);
  const title = say("identity.invites.title");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: say("web.nav.company") });
  const link = group.getByRole("link", { name: say("identity.nav.invites") });
  await expect(link).toHaveAttribute("href", SCREEN);
  const members = page
    .getByRole("main")
    .getByRole("link", { name: say("identity.invites.members") });
  await expect(members).toHaveAttribute("href", `/w/${WORKSPACE}/members`);

  const name = say("identity.invites.form.email");
  await page.getByRole("textbox", { name, exact: true }).fill(email);
  const role = page.getByRole("combobox", { name: say("identity.invites.form.role") });
  await expect(role).toHaveValue("Member");
  // exact: the workspace switcher's name holds the workspace's, "Invites".
  const submit = { name: say("identity.invites.form.submit"), exact: true };
  await page.getByRole("button", submit).click();
  await expect(toast(page, say("identity.invites.toast.sent", { email }))).toBeVisible();
  await expect(badge(page, email, "identity.invites.state.open")).toBeVisible();
  await expect(badge(page, email, "identity.invites.role.member")).toBeVisible();

  await page.getByRole("button", { name: say("identity.invites.revoke.label", { email }) }).click();
  const confirm = page.getByRole("dialog", {
    name: say("identity.invites.revoke.title", { email }),
  });
  await expect(confirm.getByText(say("identity.invites.revoke.body"))).toBeVisible();
  await confirm.getByRole("button", { name: say("identity.invites.revoke.action") }).click();
  await expect(toast(page, say("identity.invites.toast.revoked"))).toBeVisible();
  await expect(badge(page, email, "identity.invites.state.revoked")).toBeVisible();

  const again = say("identity.invites.send_again.label", { email });
  await page.getByRole("button", { name: again }).click();
  await expect(toast(page, say("identity.invites.toast.sent", { email }))).toBeVisible();
  await expect(badge(page, email, "identity.invites.state.open")).toBeVisible();
});

test("a user who already has an account accepts on /invitations and lands in the workspace as a Member", async ({
  page,
  signInAs,
  request,
  baseURL,
}) => {
  const email = `known-${randomUUID()}@example.test`;
  // The Owner's calls, in a session of their own: a sign-in accepts every open invite, so the
  // known user signs in before the invite.
  const asOwner = async (path: string, data: object) => {
    const answer = await request.post(path, { data, headers: { origin: baseURL ?? "" } });
    expect(answer.status(), await answer.text()).toBeLessThan(300);
  };
  await asOwner("/api/auth/fake/sign-in", { email: E2E_EMAIL });
  const known = { email, displayName: null, role: "Member" };
  await asOwner("/api/v1/workspaces/wsp_e2e_invitations/e2e/members", { members: [known] });
  await signInAs(email);
  await asOwner(`/api/v1/workspaces/${WORKSPACE}/identity/invites`, { email, role: "Member" });

  await page.goto("/invitations");
  const title = say("identity.invitations.title");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const item = page.getByRole("main").getByRole("listitem").filter({ hasText: "Invites" });
  await expect(
    item.getByText(say("identity.invitations.role.member"), { exact: true }),
  ).toBeVisible();
  const accept = say("identity.invitations.accept.label", { workspace: "Invites" });
  await page.getByRole("button", { name: accept }).click();
  await expect(page).toHaveURL(/\/w\/e2e-invites$/);
  const { memberships } = await (await page.request.get("/api/v1/me")).json();
  const joined = (memberships as { workspaceId: string; role: string }[]).find(
    ({ workspaceId }) => workspaceId === WORKSPACE,
  );
  expect(joined?.role).toBe("Member");
});
