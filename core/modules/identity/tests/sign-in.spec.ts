// The sign-in flows through the screens (README.md "Sign-in"), run by `pnpm -F web test` against the
// worktree's web and e2e api, on the Better Auth adapter: each test invites emails of its own with
// `pnpm invite`'s command, to the e2e api's workspace, asks for a link on /sign-in, reads it from
// Mailpit (MAILPIT_API_URL), opens it and presses the confirm page's button. The invite mail's way in
// is here too (README.md "Invites"), as the web host reads no Mailpit.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { readMailpit } from "@whytide/providers/app-mail/testing";

const dir = join(import.meta.dirname, "..");
const messages = JSON.parse(readFileSync(join(dir, "messages", "en.json"), "utf8"));
const say = (key: string): string => messages[key] ?? `no message ${key}`;
type Membership = { workspaceId: string; slug: string; name: string; role: string };
/** The e2e api's workspace (core/apps/api/tests/e2e-server.ts). */
const WORKSPACE = "wsp_fixture_a";

/**
 * A new email, invited to WORKSPACE as `pnpm invite` does, with no invite mail, so that the latest
 * mail in Mailpit is the sign-in link's; the workspace, from the command's line.
 */
function invited(): { email: string; workspaceId: string } {
  const email = `tester-${randomUUID()}@example.test`;
  const env = "--env-file-if-exists=../../../.env.local";
  const args = [env, "dist/cli/invite.js", email, "--workspace", WORKSPACE, "--no-mail"];
  const printed = execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  return { email, workspaceId: /\b(wsp_\w+)\b/.exec(printed)?.[1] ?? "no workspace" };
}

/** Asks for a link from the sign-in page the browser is on. */
async function ask(page: Page, email: string): Promise<void> {
  await page.getByLabel(say("identity.sign_in.email")).fill(email);
  await page.getByRole("button", { name: say("identity.sign_in.send") }).click();
  await expect(page).toHaveURL(/\/sign-in\/sent$/);
}

/**
 * Opens the mailed link, on the web (AUTH_BASE_URL), and presses the confirm page's button; the
 * link of a mail later than `after`, a mail's id, when given.
 */
async function follow(page: Page, email: string, after?: string): Promise<void> {
  const latest = () => readMailpit({ to: email }, { timeoutMs: 15_000 });
  await expect.poll(async () => (await latest()).messageId, { timeout: 15_000 }).not.toBe(after);
  const { text } = await latest();
  const confirm = await page.goto(/https?:\/\/\S+/.exec(text)?.[0] ?? "no link in the mail");
  await expect(page).toHaveURL(/\/sign-in\/confirm\?link=/);
  expect(confirm?.headers()["referrer-policy"]).toBe("no-referrer"); // its URL holds the token
  await page.getByRole("button", { name: say("identity.sign_in.confirm.submit") }).click();
}

test("invited: the link lands on the workspace, its name in the header; a second user joins it as Owner", async ({
  browser,
}) => {
  const joined: Membership[] = [];
  for (const { email } of [invited(), invited()]) {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/sign-in");
    await ask(page, email);
    await follow(page, email);
    await expect(page).toHaveURL(/\/w\/[a-z0-9-]+$/);
    const { memberships } = await (await page.request.get("/api/v1/me")).json();
    const [own] = memberships as Membership[];
    expect(page.url()).toMatch(new RegExp(`/w/${own?.slug}$`));
    await expect(page.getByRole("banner")).toContainText(own?.name ?? "no membership");
    await expect(page.getByRole("banner")).toContainText(email);
    joined.push(...memberships);
    await page.context().close();
  }
  const [first, second] = joined;
  expect(joined).toHaveLength(2);
  expect([first?.role, second?.role]).toEqual(["Owner", "Owner"]);
  expect(second?.workspaceId).toBe(first?.workspaceId);
});

test("not invited: the same sent page, and no mail", async ({ page }) => {
  const email = `stranger-${randomUUID()}@example.test`;
  await page.goto("/sign-in");
  await ask(page, email);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    say("identity.sign_in.sent.title"),
  );
  await expect(page.getByText(say("identity.sign_in.sent.body"))).toBeVisible();
  await expect(readMailpit({ to: email }, { timeoutMs: 3_000 })).rejects.toThrow(/no mail/);
});

test("signed out: a workspace page sends to sign-in and back after it; sign-out ends the session", async ({
  page,
}) => {
  const { email, workspaceId } = invited();
  const screen = `/w/${workspaceId}/fixture?name=ada`; // the host's test screen: no module has one yet
  await page.goto(screen);
  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(screen)}`);
  await ask(page, email);
  await follow(page, email);
  await expect(page).toHaveURL(screen);
  await expect(page.getByText("The api says hello to ada.")).toBeVisible();
  const [session] = await page.context().cookies();
  await page.getByRole("banner").getByRole("button", { name: email }).click(); // the menu shows it too
  await page.getByRole("button", { name: say("identity.account.sign_out") }).click();
  await expect(page).toHaveURL("/sign-in");
  expect(await page.context().cookies()).toEqual([]);
  const old = { cookie: `${session?.name}=${session?.value}` };
  expect((await page.request.get("/api/v1/me", { headers: old })).status()).toBe(401);
  await page.goto(screen);
  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(screen)}`);
});

test("expired: a used link lands on /sign-in/expired, with the way back to /sign-in", async ({
  page,
}) => {
  const { email } = invited();
  await page.goto("/sign-in");
  await ask(page, email);
  await follow(page, email);
  await expect(page).toHaveURL(/\/w\/[a-z0-9-]+$/);
  await page.context().clearCookies();
  await follow(page, email);
  await expect(page).toHaveURL("/sign-in/expired?code=auth_link_expired");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    say("identity.sign_in.expired.title"),
  );
  await page.getByRole("link", { name: say("identity.sign_in.expired.retry") }).click();
  await expect(page).toHaveURL("/sign-in");
});

test("invited on the Invites screen: the mail's /invitations signs the invitee in there, a Member of the workspace, who reads the screen's hint", async ({
  browser,
}) => {
  const owner = await (await browser.newContext()).newPage();
  const { email: ownerEmail } = invited();
  await owner.goto("/sign-in");
  await ask(owner, ownerEmail);
  await follow(owner, ownerEmail);
  const email = `invitee-${randomUUID()}@example.test`;
  await owner.goto(`/w/${WORKSPACE}/invites`);
  const field = { name: say("identity.invites.form.email"), exact: true };
  await owner.getByRole("textbox", field).fill(email);
  const submit = { name: say("identity.invites.form.submit"), exact: true };
  await owner.getByRole("button", submit).click();
  await expect(owner.getByRole("status").filter({ hasText: email })).toBeVisible();

  const mail = await readMailpit({ to: email }, { timeoutMs: 15_000 });
  expect(mail.text.match(/https?:\/\/\S+/g)).toEqual([expect.stringMatching(/\/invitations$/)]);
  const page = await (await browser.newContext()).newPage();
  await page.goto("/invitations");
  await expect(page.getByText(say("identity.invitations.signed_out.body"))).toBeVisible();
  await page.getByRole("link", { name: say("identity.invitations.signed_out.action") }).click();
  await expect(page).toHaveURL("/sign-in?next=%2Finvitations");
  await ask(page, email);
  await follow(page, email, mail.messageId);
  await expect(page).toHaveURL("/invitations");
  await expect(page.getByText(say("identity.invitations.empty"))).toBeVisible();
  await page.getByRole("link", { name: say("identity.invitations.open_app") }).click();
  await expect(page).toHaveURL(/\/w\/fixture-a$/);
  const { memberships } = await (await page.request.get("/api/v1/me")).json();
  expect(memberships).toMatchObject([{ workspaceId: WORKSPACE, role: "Member" }]);
  await page.goto(`/w/${WORKSPACE}/invites`);
  await expect(page.getByText(say("identity.invites.hint"))).toBeVisible();
  await expect(page.getByRole("textbox", field)).toHaveCount(0);
});
