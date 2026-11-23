// The LinkedIn screen's health card (beta-p6-040; core/modules/linkedin/README.md "Screen",
// "Health"), as e2e@example.com in wsp_e2e_linkedin_health: the account connected through the fake's
// hosted link, its health seeded through the e2e api's route, which stands in for the absent worker
// too. Each state with its hints; "Check status", then Resume behind its Dialog; another member's
// account, as an Owner sees a teammate's (gamma-p6-070), routed: a hint, no buttons; the fleet
// breaker and no events, routed (a real breaker would pause every spec's invites); loading, error
// and retry; a phone's width. Every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_linkedin_health";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const ACCOUNTS = `${API}/linkedin/accounts`;
const HEALTH = `**${ACCOUNTS}/*/health`;
const messages: Record<string, string> = { ...linkedin, ...ui };
type Seed = { state: string; cooldownEndsIn?: number; statusCheckedAgo?: number };

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

test("the health card: each state and its hints; Check status, then Resume behind its Dialog; no buttons but the owner's; the breaker and no events; loading, error and retry; a phone's width", async ({
  page,
  signInAs,
  baseURL,
}) => {
  // Seven reloads, a poll and three axe runs: past Playwright's 30 seconds on a loaded laptop.
  test.slow();
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  const { accounts } = await (await page.request.get(ACCOUNTS)).json();
  type Account = { mine: boolean; status: string };
  if (!accounts.some((account: Account) => account.mine && account.status === "connected")) {
    const data = {
      timeZone: "UTC",
      acknowledged: true,
      disclosureVersion: 2,
      personalAccount: true,
    };
    const connect = await page.request.post(`${ACCOUNTS}/connect`, { data, headers });
    const { url } = await connect.json();
    expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
  }
  const seed = async (data: Seed) => {
    const answer = await page.request.post(`${API}/e2e/linkedin-health`, { data, headers });
    expect(answer.status(), await answer.text()).toBe(200);
  };
  const card = page.getByRole("region", { name: say("linkedin.health.title") });
  const shows = (key: string) => expect(card.getByText(say(key), { exact: true })).toBeVisible();
  const check = card.getByRole("button", { name: say("linkedin.health.check") });
  const resume = card.getByRole("button", { name: say("linkedin.health.resume") });

  // Restricted, still cooling down: the cause, the cool-down's end, what to do; Resume waits.
  await seed({ state: "restricted", cooldownEndsIn: 600, statusCheckedAgo: 1 });
  await page.goto(`/w/${WORKSPACE}/linkedin`);
  await shows("linkedin.health.state.restricted");
  await shows("linkedin.health.trigger.limit_reached");
  await shows("linkedin.health.since");
  await shows("linkedin.health.until");
  await shows("linkedin.health.todo.restricted");
  await shows("linkedin.health.blocked.cooldown_active");
  await expect(card.getByRole("listitem").first()).toBeVisible();
  await expect(check).toBeEnabled();
  await expect(resume).toBeDisabled();
  await expectNoSeriousViolation(page);

  // Over, its status read before the end: Check status, the worker's answer seeded in its stead.
  await seed({ state: "restricted", cooldownEndsIn: -60, statusCheckedAgo: 120 });
  await page.reload();
  await shows("linkedin.health.blocked.status_check_required");
  await expect(resume).toBeDisabled();
  await check.click();
  await seed({ state: "restricted", cooldownEndsIn: -60, statusCheckedAgo: 0 });
  await expect(resume).toBeEnabled({ timeout: 15_000 });

  // Resume behind its Dialog: Cancel changes nothing; Resume, the account healthy.
  await resume.click();
  const dialog = page.getByRole("dialog", { name: say("linkedin.health.resume_title") });
  await expect(dialog.getByText(say("linkedin.health.resume_body"))).toBeVisible();
  await expectNoSeriousViolation(page);
  await dialog.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(dialog).toBeHidden();
  await shows("linkedin.health.state.restricted");
  await resume.click();
  await dialog.getByRole("button", { name: say("linkedin.health.resume") }).click();
  await shows("linkedin.health.state.healthy");
  await expect(page.getByText(say("linkedin.health.resumed"))).toBeVisible();

  // A checkpoint with no pairing since: disconnect and connect again first.
  await seed({ state: "checkpoint", cooldownEndsIn: -60, statusCheckedAgo: 1 });
  await page.reload();
  await shows("linkedin.health.todo.checkpoint");
  await shows("linkedin.health.blocked.reconnect_required");
  await expect(resume).toBeDisabled();

  // Another member's account, as an Owner sees a teammate's under their own: a hint, no buttons.
  await page.route(`**${ACCOUNTS}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const teammate = { mine: false, canEdit: false };
    const accounts = json.accounts.map((account: object) => ({ ...account, ...teammate }));
    await route.fulfill({ response, json: { ...json, accounts } });
  });
  await page.reload();
  await shows("linkedin.health.manage_only");
  await expect(card.getByRole("button")).toHaveCount(0);
  await page.unroute(`**${ACCOUNTS}`);

  // A session a send found lost while the status reads connected: Check status, no Resume.
  await seed({ state: "disconnected" });
  await page.reload();
  await shows("linkedin.health.disconnected_connected");
  await expect(check).toBeEnabled();
  await expect(resume).toHaveCount(0);

  // At risk, its note and the rate; then healthy, with the fleet breaker and no events, routed.
  await seed({ state: "at_risk" });
  await page.reload();
  await shows("linkedin.health.at_risk");
  await shows("linkedin.health.rate_unknown");
  await seed({ state: "healthy" });
  await page.route(HEALTH, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, invitesPaused: true, events: [] } });
  });
  await page.reload();
  await shows("linkedin.health.state.healthy");
  await shows("linkedin.health.pending_unknown");
  await shows("linkedin.health.breaker");
  await shows("linkedin.health.no_events");
  await page.unroute(HEALTH);

  // Loading, held; then its error, and the retry.
  const held = Promise.withResolvers<void>();
  await page.route(HEALTH, async (route) => {
    await held.promise;
    await route.fulfill({ status: 500, json: { code: "internal_error" } });
  });
  await page.reload();
  await expect(card.getByText(say("ui.state.loading"))).toBeVisible();
  held.resolve();
  await expect(card.getByRole("alert")).toBeVisible();
  await expectNoSeriousViolation(page);
  await page.unroute(HEALTH);
  await card.getByRole("button", { name: say("ui.action.retry") }).click();
  await shows("linkedin.health.state.healthy");

  // A phone's width: the paused card scrolls nothing sideways.
  await seed({ state: "restricted", cooldownEndsIn: 600, statusCheckedAgo: 1 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(resume).toBeDisabled();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page)).toEqual([]);
});
