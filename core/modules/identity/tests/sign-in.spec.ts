// The sign-in flows through the screens (README.md "Sign-in"), run by `pnpm -F web test` against the
// worktree's web and e2e api, on the Better Auth adapter: each test invites emails of its own with
// `pnpm invite`'s command, to the e2e api's workspace, asks for a link on /sign-in, reads it from
// Mailpit (MAILPIT_API_URL), opens it and presses the confirm page's button.
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

/** A new email, invited to WORKSPACE as `pnpm invite` does; the workspace, from the command's line. */
function invited(): { email: string; workspaceId: string } {
  const email = `tester-${randomUUID()}@example.test`;
  const env = "--env-file-if-exists=../../../.env.local";
  const args = [env, "dist/cli/invite.js", email, "--workspace", WORKSPACE];
  const printed = execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  return { email, workspaceId: /\b(wsp_\w+)\b/.exec(printed)?.[1] ?? "no workspace" };
}

/** Asks for a link from the sign-in page the browser is on. */
async function ask(page: Page, email: string): Promise<void> {
  await page.getByLabel(say("identity.sign_in.email")).fill(email);
  await page.getByRole("button", { name: say("identity.sign_in.send") }).click();
  await expect(page).toHaveURL(/\/sign-in\/sent$/);
}

/** Opens the mailed link, on the web (AUTH_BASE_URL), and presses the confirm page's button. */
async function follow(page: Page, email: string): Promise<void> {
  const { text } = await readMailpit({ to: email }, { timeoutMs: 15_000 });
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
