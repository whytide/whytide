// email's mailboxes screen end to end (gamma-p1-010; core/modules/email README.md "Screen"), on the
// mailbox fake, whose consent address is the callback page itself, with a code and the state: Connect
// Google lands there, the page posts with no code left in its address and no Referer, and the card
// shows the address, the provider and "connected"; Disconnect, confirmed, leaves the banner with the
// reason and Reconnect, which goes back through the consent to the same mailbox; a revoked token,
// marked by the e2e module as the worker would, shows its banner, and Connect Microsoft connects the
// mailbox again under that provider.
import email from "../../../modules/email/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_email";
/** The address the fake's consent grants when no consentNext says otherwise. */
const ADDRESS = "member@fake-mailbox.example";
const messages: Record<string, string> = { ...email, ...ui };

/** The text of a key, with the address; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace("{address}", ADDRESS);
}

test("connect, disconnect and reconnect a mailbox on the fake; a revoked token's banner", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  const seed = (state: "none" | "token_revoked") =>
    page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/email-mailbox`, {
      data: { state },
      headers,
    });
  expect(await seed("none")).toBeOK();
  /** The address and the Referer the callback's post leaves with. */
  const posts: { url: string; referer: string | undefined }[] = [];
  await page.route("**/email/mailboxes/callback", async (route) => {
    posts.push({ url: page.url(), referer: route.request().headers().referer });
    await route.continue();
  });
  const card = page.getByRole("region", { name: ADDRESS });

  await page.goto(`/w/${WORKSPACE}/mailboxes`);
  await expect(page.getByText(say("email.mailboxes.setup.title"))).toBeVisible();
  const landed = page.waitForResponse((answer) => answer.url().includes("/email/callback?"));
  await page.getByRole("button", { name: say("email.mailboxes.connect.google") }).click();
  expect((await landed).headers()["referrer-policy"]).toBe("no-referrer");
  await page.waitForURL(`**/w/${WORKSPACE}/mailboxes`);
  await expect(card.getByText(say("email.mailboxes.status.connected"))).toBeVisible();
  await expect(card.getByText(say("email.mailboxes.provider.google"))).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(new URL(posts[0]?.url ?? "").search).toBe("");
  expect(posts[0]?.referer).toBeUndefined();

  await card.getByRole("button", { name: say("email.mailboxes.disconnect") }).click();
  const dialog = page.getByRole("dialog", { name: say("email.mailboxes.disconnect_title") });
  await dialog.getByRole("button", { name: say("email.mailboxes.disconnect") }).click();
  await expect(page.getByText(say("email.mailboxes.reason.user"))).toBeVisible();
  await expect(card).toHaveCount(0);

  await page.getByRole("button", { name: say("email.mailboxes.reconnect") }).click();
  await page.waitForURL(`**/w/${WORKSPACE}/mailboxes`);
  await expect(card.getByText(say("email.mailboxes.status.connected"))).toBeVisible();

  expect(await seed("token_revoked")).toBeOK();
  await page.reload();
  await expect(page.getByText(say("email.mailboxes.reason.token_revoked"))).toBeVisible();
  await page.getByRole("button", { name: say("email.mailboxes.connect.microsoft") }).click();
  await page.waitForURL(`**/w/${WORKSPACE}/mailboxes`);
  await expect(card.getByText(say("email.mailboxes.status.connected"))).toBeVisible();
  await expect(card.getByText(say("email.mailboxes.provider.microsoft"))).toBeVisible();
  expect(posts).toHaveLength(3);
});
