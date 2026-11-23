// The LinkedIn screen's switches (beta-p1-040, criterion 9; core/modules/linkedin/README.md
// "Screen"), as e2e@example.com in wsp_e2e_switches, this spec's alone: the account connected once
// through the fake's hosted link, every stop lifted first through the e2e api's seed route
// (core/apps/api/tests/fixtures/e2e). The account's pause and the workspace's "Stop everything" each
// ask for confirmation both ways, Cancel changing nothing; the operator's pause and stop, which the
// seed route writes, show locked with the reason; the instance's stop, routed (a real one would stop
// every spec's workspace), locks "Stop everything"; a viewer the account's canPause lets not pause it,
// routed as linkedin-read-cap.spec.ts does, sees the pause disabled with its hint; the stop's error
// state and its retry. In wsp_e2e_teammates (gamma-p6-070), with a teammate the e2e api's members
// route makes a Member: an Owner sees their own account first, then the teammate's, titled with the
// name, and pauses it; a removed member's pause, which the seed route writes on the teammate's
// account, shows locked to the Owner; the teammate sees their own account alone, lifts that pause,
// and sees "Stop everything" disabled with its hint; at a phone's width, the Owner's screen fits.
// Every text from its key, and axe.
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
type Account = { id: string; mine: boolean; status: string; canPause: boolean };
type Holder = "tester" | "operator" | null;

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}
const TEAMMATES = "wsp_e2e_teammates";
/** A Member of TEAMMATES with an account of their own, made by the e2e api's members route. */
const TEAMMATE = {
  email: "e2e-teammate@example.com",
  displayName: "Tara Teammate",
  role: "Member",
};
/** The account's label as a connect leaves it (linkedin's DEFAULT_LABEL): the own card's name. */
const LABEL = "LinkedIn";

/** What is wider than the window: the document, main or an ancestor of main (phone-width.spec.ts). */
function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const wide: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) wide.push(`document ${root.scrollWidth}`);
    for (let box = document.querySelector("main"); box; box = box.parentElement) {
      if (box.scrollWidth > box.clientWidth) wide.push(`${box.tagName} ${box.scrollWidth}`);
    }
    return wide;
  });
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the account's pause and the workspace's stop, each confirmed both ways; the operator's pause and stop, and the instance's stop, locked with the reason; a viewer the route lets not pause sees it disabled with its hint; the stop's error and retry", async ({
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

  // A viewer the route lets not pause the account, routed: the pause disabled, with its hint.
  await page.route(`**${ACCOUNTS}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const account of json.accounts as Account[]) account.canPause = false;
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

test("an Owner sees their own account first, then a teammate's, titled with the name, and pauses it; a removed member's pause shows locked to the Owner; the teammate, a Member, sees their own account alone, lifts that pause, and sees Stop everything disabled with its hint; a phone's width", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // five sign-ins, two hosted links, three reloads, two dialogs and three axe runs
  const api = `/api/v1/workspaces/${TEAMMATES}`;
  const accounts = `${api}/linkedin/accounts`;
  const headers = { origin: baseURL ?? "" };
  const list = async () => (await (await page.request.get(accounts)).json()).accounts as Account[];
  /** The signed-in user's account, connected through the fake's hosted link once, its pause seeded. */
  const ready = async (pause: "member_removed" | null) => {
    if ((await list()).find((account) => account.mine)?.status !== "connected") {
      const data = {
        timeZone: "UTC",
        acknowledged: true,
        disclosureVersion: 2,
        personalAccount: true,
      };
      const { url } = await (
        await page.request.post(`${accounts}/connect`, { data, headers })
      ).json();
      expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
    }
    const data = { platformStopped: false, workspace: null, account: pause };
    const answer = await page.request.post(`${api}/e2e/linkedin-controls`, { data, headers });
    expect(answer.status(), await answer.text()).toBe(200);
  };
  await signInAs();
  const members = { members: [TEAMMATE] };
  const added = await page.request.post(`${api}/e2e/members`, { data: members, headers });
  expect(added.status(), await added.text()).toBe(200);
  await ready(null);
  await signInAs(TEAMMATE.email);
  await ready(null);

  // The Owner: their own account first, then the teammate's, which they pause.
  await signInAs();
  await page.goto(`/w/${TEAMMATES}/linkedin`);
  const own = page.getByRole("region", { name: LABEL, exact: true });
  const teammates = page.getByRole("region", { name: say("linkedin.accounts.teammates.title") });
  const name = say("linkedin.accounts.teammate.title").replace("{name}", TEAMMATE.displayName);
  const card = teammates.getByRole("region", { name });
  const switchIn = (scope: typeof own) =>
    scope.getByRole("switch", { name: say("linkedin.controls.pause.label") });
  await expect(own).toBeVisible();
  await expect(card).toBeVisible();
  const [first, then] = [await own.boundingBox(), await teammates.boundingBox()];
  expect((first?.y ?? Infinity) < (then?.y ?? -Infinity), "the own account first").toBe(true);
  const pause = switchIn(card);
  await expect(pause).not.toBeChecked();
  await expect(pause).toBeEnabled();
  await expectNoSeriousViolation(page);
  await pause.click();
  const pausing = page.getByRole("dialog", { name: say("linkedin.controls.pause.confirm_title") });
  await pausing.getByRole("button", { name: say("linkedin.controls.pause.confirm") }).click();
  await expect(pause).toBeChecked();
  await expect(pause).toBeEnabled(); // an Owner lifts a tester's pause too
  const teammate = (await list()).find((account) => !account.mine);
  expect(teammate).toMatchObject({ paused: true, pausedBy: "tester", canUnpause: true });

  // A removed member's pause, as the account keeps it after a new invite: locked to the Owner.
  await signInAs(TEAMMATE.email);
  await ready("member_removed");
  await signInAs();
  await page.reload();
  await expect(pause).toBeChecked();
  await expect(pause).toBeDisabled();
  await expect(card.getByText(say("linkedin.controls.pause.member_removed"))).toBeVisible();
  await expect(card.getByText(say("linkedin.controls.locked.member_removed"))).toBeVisible();
  await expectNoSeriousViolation(page);

  // The teammate, a Member: their own account alone, the pause theirs to lift; "Stop everything"
  // disabled, with its hint.
  await signInAs(TEAMMATE.email);
  await page.reload();
  const mine = switchIn(own);
  await expect(mine).toBeChecked();
  await expect(mine).toBeEnabled();
  await expect(teammates).toHaveCount(0);
  await expect(own.getByText(say("linkedin.controls.pause.member_removed"))).toBeVisible();
  const stop = page.getByRole("switch", { name: say("linkedin.controls.stop.label") });
  await expect(stop).toBeDisabled();
  await expect(page.getByText(say("linkedin.controls.hint.stop_manage_only"))).toBeVisible();
  await expectNoSeriousViolation(page);
  await mine.click();
  const resuming = page.getByRole("dialog", {
    name: say("linkedin.controls.resume.confirm_title"),
  });
  await resuming.getByRole("button", { name: say("linkedin.controls.resume.confirm") }).click();
  await expect(mine).not.toBeChecked();
  const lifted = (await list()).find((account) => account.mine);
  expect(lifted).toMatchObject({ paused: false, pausedBy: null });

  // A phone's width: the Owner's screen, the teammate's card with it, scrolls nothing sideways.
  await signInAs();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(card).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page)).toEqual([]);
});
