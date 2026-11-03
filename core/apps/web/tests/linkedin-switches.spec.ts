// The LinkedIn screen's switches (beta-p1-040, criterion 9; core/modules/linkedin/README.md
// "Screen"), as e2e@example.com in wsp_e2e_switches, this spec's alone: the account connected once
// through the fake's hosted link, every stop lifted first through the e2e api's seed route
// (core/apps/api/tests/fixtures/e2e). The account's pause and the workspace's "Stop everything" each
// ask for confirmation both ways, Cancel changing nothing; the operator's pause and stop, which the
// seed route writes, show locked with the reason; the instance's stop, routed (a real one would stop
// every spec's workspace), locks "Stop everything"; a member without linkedin.manage, routed as
// linkedin-read-cap.spec.ts does, sees the pause disabled with its hint; the stop's error state and
// its retry. Every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_switches";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const ACCOUNTS = `${API}/linkedin/accounts`;
const CONTROLS = `${API}/linkedin/controls`;
const messages: Record<string, string> = { ...linkedin, ...ui };
type Account = { id: string; mine: boolean; status: string; canManage: boolean };
type Holder = "tester" | "operator" | null;

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

test("the account's pause and the workspace's stop, each confirmed both ways; the operator's pause and stop, and the instance's stop, locked with the reason; without linkedin.manage, the pause disabled with its hint; the stop's error and retry", async ({
  page,
  signInAs,
  baseURL,
}) => {
  // Four reloads, five dialogs and five axe runs: past Playwright's 30 seconds on a loaded laptop.
  test.slow();
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  const mine = async () => {
    const { accounts } = await (await page.request.get(ACCOUNTS)).json();
    return (accounts as Account[]).find((account) => account.mine);
  };
  if ((await mine())?.status !== "connected") {
    const data = {
      timeZone: "UTC",
      acknowledged: true,
      disclosureVersion: 2,
      personalAccount: true,
    };
    const { url } = await (
      await page.request.post(`${ACCOUNTS}/connect`, { data, headers })
    ).json();
    expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
  }
  const seed = async (workspace: Holder, account: Holder) => {
    const data = { platformStopped: false, workspace, account };
    const answer = await page.request.post(`${API}/e2e/linkedin-controls`, { data, headers });
    expect(answer.status(), await answer.text()).toBe(200);
  };
  await seed(null, null);

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const pause = page.getByRole("switch", { name: say("linkedin.controls.pause.label") });
  const stop = page.getByRole("switch", { name: say("linkedin.controls.stop.label") });
  await expect(pause).not.toBeChecked();
  await expect(pause).toBeEnabled();
  await expect(stop).not.toBeChecked();
  await expect(stop).toBeEnabled();
  await expectNoSeriousViolation(page);

  // The pause: Cancel changes nothing; Pause pauses; Resume resumes.
  await pause.click();
  const pausing = page.getByRole("dialog", { name: say("linkedin.controls.pause.confirm_title") });
  await expect(pausing.getByText(say("linkedin.controls.pause.confirm_body"))).toBeVisible();
  await expectNoSeriousViolation(page);
  await pausing.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(pausing).toBeHidden();
  await expect(pause).not.toBeChecked();
  await pause.click();
  await pausing.getByRole("button", { name: say("linkedin.controls.pause.confirm") }).click();
  await expect(pause).toBeChecked();
  await expect(page.getByText(say("linkedin.controls.pause.on"))).toBeVisible();
  expect(await mine()).toMatchObject({ paused: true, pausedBy: "tester" });
  await pause.click();
  const resuming = page.getByRole("dialog", {
    name: say("linkedin.controls.resume.confirm_title"),
  });
  await expect(resuming.getByText(say("linkedin.controls.resume.confirm_body"))).toBeVisible();
  await resuming.getByRole("button", { name: say("linkedin.controls.resume.confirm") }).click();
  await expect(pause).not.toBeChecked();
  expect(await mine()).toMatchObject({ paused: false, pausedBy: null });

  // "Stop everything": Cancel changes nothing; on, then lifted.
  await stop.click();
  const stopping = page.getByRole("dialog", { name: say("linkedin.controls.stop.confirm_title") });
  await expect(stopping.getByText(say("linkedin.controls.stop.confirm_body"))).toBeVisible();
  await stopping.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(stop).not.toBeChecked();
  await stop.click();
  await stopping.getByRole("button", { name: say("linkedin.controls.stop.confirm") }).click();
  await expect(stop).toBeChecked();
  await expect(page.getByText(say("linkedin.controls.stop.on"))).toBeVisible();
  const stopped = await (await page.request.get(CONTROLS)).json();
  expect(stopped.workspace).toEqual({ stopped: true, stopSource: "tester" });
  await expectNoSeriousViolation(page);
  await stop.click();
  const lifting = page.getByRole("dialog", { name: say("linkedin.controls.lift.confirm_title") });
  await expect(lifting.getByText(say("linkedin.controls.lift.confirm_body"))).toBeVisible();
  await lifting.getByRole("button", { name: say("linkedin.controls.lift.confirm") }).click();
  await expect(stop).not.toBeChecked();
  expect((await (await page.request.get(CONTROLS)).json()).workspace.stopped).toBe(false);

  // The operator's pause and stop: on, locked, each saying so.
  await seed("operator", "operator");
  await page.reload();
  await expect(pause).toBeChecked();
  await expect(pause).toBeDisabled();
  await expect(page.getByText(say("linkedin.controls.locked.account"))).toBeVisible();
  await expect(stop).toBeChecked();
  await expect(stop).toBeDisabled();
  await expect(page.getByText(say("linkedin.controls.locked.workspace"))).toBeVisible();
  await expectNoSeriousViolation(page);
  await seed(null, null);

  // The instance's stop, routed: "Stop everything" locked, saying so.
  await page.route(`**${CONTROLS}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.platform.stopped = true;
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(stop).toBeDisabled();
  await expect(page.getByText(say("linkedin.controls.locked.platform"))).toBeVisible();
  await page.unroute(`**${CONTROLS}`);

  // A member without linkedin.manage, routed: the pause disabled, with its hint.
  await page.route(`**${ACCOUNTS}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const account of json.accounts as Account[]) account.canManage = false;
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(pause).toBeDisabled();
  await expect(page.getByText(say("linkedin.controls.hint.manage_only"))).toBeVisible();
  await page.unroute(`**${ACCOUNTS}`);

  // The stop's error state, then its retry.
  let failing = true;
  await page.route(`**${CONTROLS}`, async (route) => {
    if (!failing) return route.continue();
    await route.fulfill({ status: 500, json: { code: "internal_error" } });
  });
  await page.reload();
  await expect(page.getByText(say("linkedin.controls.stop.error"))).toBeVisible();
  await expectNoSeriousViolation(page);
  failing = false;
  await page.getByRole("button", { name: say("ui.action.retry") }).click();
  await expect(stop).not.toBeChecked();
  await expect(stop).toBeEnabled();
});
