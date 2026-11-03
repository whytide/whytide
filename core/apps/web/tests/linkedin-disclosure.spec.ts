// The risk disclosure for sending on the LinkedIn screen (beta-p1-070, criterion 12;
// core/modules/linkedin README.md "Screen"), as e2e@example.com in wsp_e2e_disclosure, this spec's
// alone: the connect card's text and its two boxes, Connect off until both are ticked, then the
// fake's hosted link and back; the account set back to alpha's disclosure, version 1, by the e2e
// api's seed route (core/apps/api/tests/fixtures/e2e): the card's notice and "Read and accept", the
// Dialog with the text and the personal-account box, Cancel changing nothing, Accept off until the box
// is ticked, a failed press in words with its retry; once accepted, the toast, and no notice after a
// reload. The hint for another member is not reachable: the screen shows the viewer's own account
// only (README.md "Open questions"). Every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_disclosure";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const ACCOUNTS = `${API}/linkedin/accounts`;
const messages: Record<string, string> = { ...linkedin, ...ui };
type Account = { id: string; mine: boolean; status: string };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("connect after the text and both boxes; an account at alpha's disclosure shows the notice, and its owner accepts through the Dialog: Cancel changes nothing, Accept waits for the box, a failed press retries, the notice goes", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // a hosted link, four axe runs and two reloads
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  const mine = async () => {
    const { accounts } = await (await page.request.get(ACCOUNTS)).json();
    return (accounts as Account[]).find((account) => account.mine);
  };
  const earlier = await mine(); // from an earlier run: disconnected, so the connect card shows
  if (earlier !== undefined && earlier.status !== "disconnected") {
    expect(await page.request.delete(`${ACCOUNTS}/${earlier.id}`, { headers })).toBeOK();
  }

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  await expect(page.getByText(say("linkedin.connect.disclosure"))).toBeVisible();
  const connect = page.getByRole("button", { name: say("linkedin.connect.button") });
  await expect(connect).toBeDisabled();
  await page.getByRole("checkbox", { name: say("linkedin.connect.personal_account") }).check();
  await expect(connect).toBeDisabled();
  await page.getByRole("checkbox", { name: say("linkedin.connect.acknowledge") }).check();
  await expect(connect).toBeEnabled();
  await expect(connect).toHaveCSS("opacity", "1"); // the button's fade-in over, before axe
  await expectNoSeriousViolation(page);
  await connect.click();
  await page.waitForURL(`**/w/${WORKSPACE}/linkedin?connect=done`);
  const card = page.getByRole("region", { name: "LinkedIn", exact: true });
  await expect(
    card.getByText(say("linkedin.account.status.connected"), { exact: true }),
  ).toBeVisible();
  const notice = page.getByText(say("linkedin.disclosure.notice"));
  await expect(notice).toHaveCount(0);
  expect(await mine()).toMatchObject({ disclosureVersion: 2, sendingDisclosureRequired: false });

  const seeded = await page.request.post(`${API}/e2e/linkedin-disclosure`, { headers });
  expect(seeded.status(), await seeded.text()).toBe(200);
  await page.reload();
  await expect(notice).toBeVisible();
  await expectNoSeriousViolation(page);
  const review = page.getByRole("button", { name: say("linkedin.disclosure.review") });
  const dialog = page.getByRole("dialog", { name: say("linkedin.disclosure.title") });
  const accept = dialog.getByRole("button", { name: say("linkedin.disclosure.accept") });
  const personal = dialog.getByRole("checkbox", { name: say("linkedin.connect.personal_account") });

  // Cancel changes nothing.
  await review.click();
  await expect(dialog.getByText(say("linkedin.connect.disclosure"))).toBeVisible();
  await expect(accept).toBeDisabled();
  await personal.check();
  await dialog.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(dialog).toBeHidden();
  await expect(notice).toBeVisible();
  expect(await mine()).toMatchObject({ disclosureVersion: 1, sendingDisclosureRequired: true });

  // Accept waits for the box; a failed press shows its error in the Dialog, and its retry accepts.
  await review.click();
  await expect(personal).not.toBeChecked(); // the box starts empty again
  await personal.check();
  await expect(accept).toBeEnabled();
  await expect(accept).toHaveCSS("opacity", "1");
  await expectNoSeriousViolation(page);
  await page.route(`**${ACCOUNTS}/*/disclosure`, (route) =>
    route.fulfill({ status: 500, json: { code: "internal_error" } }),
  );
  await accept.click();
  await expect(dialog.getByRole("alert")).toContainText(say("ui.state.error"));
  await page.unroute(`**${ACCOUNTS}/*/disclosure`);
  await dialog.getByRole("button", { name: say("ui.action.retry") }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(say("linkedin.disclosure.accepted"))).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(await mine()).toMatchObject({ disclosureVersion: 2, sendingDisclosureRequired: false });
  await page.reload();
  await expect(
    card.getByText(say("linkedin.account.status.connected"), { exact: true }),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
});
