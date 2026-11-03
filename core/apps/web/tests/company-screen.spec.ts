// onboarding's Company Knowledge screen end to end (alpha-p4-010; core/modules/onboarding/README.md
// "The screen"), on the e2e api: a one-liner typed, saved and reloaded with its "edited" badge, the
// tone's counter at its limit, axe; then the e2e user's second workspace, whose screen and api never
// show the first one's record.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const A = "wsp_fixture_a"; // the api's fixture module's workspace
const B = "wsp_e2e_b"; // the e2e user's second workspace (core/apps/api/tests/e2e-server.ts)
const messages: Record<string, string> = { ...ui, ...onboarding };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const field = (page: Page, key: string) => page.getByLabel(say(key), { exact: true });

/** Types a one-liner new to this run into the workspace's screen and saves it. */
async function saveOneLiner(page: Page, workspace: string): Promise<string> {
  await page.goto(`/w/${workspace}/company`);
  const text = `Robots for warehouses ${Date.now()}`;
  await field(page, "onboarding.company.one_liner").fill(text);
  await page.getByRole("button", { name: say("ui.action.save") }).click();
  await expect(page.getByText(say("onboarding.company.saved"))).toBeVisible();
  return text;
}

test("a one-liner saved and reloaded shows with the edited badge; the tone stops at 500; axe passes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const text = await saveOneLiner(page, A);
  await page.reload();
  await expect(page).toHaveTitle(say("onboarding.company.title"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("onboarding.company.title"));
  await expect(field(page, "onboarding.company.one_liner")).toHaveValue(text);
  const badge = page
    .locator('[data-field="oneLiner"]')
    .getByText(say("onboarding.company.source.human"));
  await expect(badge).toBeVisible();
  const tone = field(page, "onboarding.company.tone");
  await tone.fill("x".repeat(501));
  await expect(tone).toHaveValue("x".repeat(500));
  await expect(tone).toHaveAccessibleDescription(/^500\D+500\D/);
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});

test("the second workspace's screen and api never show the first one's record", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const text = await saveOneLiner(page, A);
  await page.goto(`/w/${B}/company`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("onboarding.company.title"));
  await expect(field(page, "onboarding.company.one_liner")).not.toHaveValue(text);
  const read = async (workspace: string) => {
    const answer = await page.request.get(
      `/api/v1/workspaces/${workspace}/onboarding/company-knowledge`,
    );
    expect(answer.status()).toBe(200);
    return ((await answer.json()) as { oneLiner: string }).oneLiner;
  };
  expect(await read(B)).not.toBe(text);
  expect(await read(A)).toBe(text);
});
