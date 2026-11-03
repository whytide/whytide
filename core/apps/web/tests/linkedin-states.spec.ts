// The LinkedIn screen's states and Refresh status (alpha-p10-130, acceptance criteria 1 and 2;
// core/modules/linkedin README.md "Screen"), as e2e-states@example.com, whose account no other spec
// touches. The account panel loading while the api is held, failing with a retry, then empty; the
// usage panel failing, its retry loading, then the reads left; the risk disclosure again; Refresh
// status, sent to the e2e api, which runs no worker: the account's next answer is changed here to
// what the worker would store, and the card explains the new sign-in, with Connect. The api fails
// through Playwright's routing only; every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const EMAIL = "e2e-states@example.com";
const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const SECOND = "wsp_e2e_b"; // the e2e users' second workspace: this user connects nothing there
const accountsOf = (workspace: string) => `/api/v1/workspaces/${workspace}/linkedin/accounts`;
const messages: Record<string, string> = { ...linkedin, ...platform, ...ui };
type Account = { id: string; mine: boolean; status: string };

/** The text of a key, its arguments in place; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => values[name] ?? "");
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the account panel loads while the api is held, fails with a retry, and the retry shows the empty state with Connect", async ({
  page,
  signInAs,
}) => {
  await signInAs(EMAIL);
  const held = Promise.withResolvers<void>();
  let calls = 0;
  await page.route(`**${accountsOf(SECOND)}`, async (route) => {
    calls += 1;
    if (calls > 1) return route.fallback();
    await held.promise;
    await route.fulfill({ status: 500, json: { code: "internal_error" } });
  });
  await page.goto(`/w/${SECOND}/linkedin`);
  const loading = page.getByRole("region", { name: say("linkedin.accounts.loading") });
  await expect(loading.getByRole("status")).toHaveText(say("ui.state.loading"));
  held.resolve();
  const failed = page.getByRole("region", { name: say("linkedin.accounts.error") });
  await expect(failed.getByRole("alert")).toContainText(say("ui.state.error"));
  await expect(failed.getByRole("alert")).toContainText(say("platform.error.generic"));
  await failed.getByRole("button", { name: say("ui.action.retry") }).click();
  await expect(page.getByText(say("linkedin.accounts.empty"))).toBeVisible();
  await expect(page.getByRole("button", { name: say("linkedin.connect.button") })).toBeVisible();
  expect(calls).toBe(2);
  await expectNoSeriousViolation(page);
});

test("the usage panel fails with a retry, then shows the reads left; the disclosure shows again; Refresh status waits for the new status, which explains the new sign-in, with Connect", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs(EMAIL);
  const accounts = accountsOf(WORKSPACE);
  const mine = async () => {
    const { accounts: all } = await (await page.request.get(accounts)).json();
    return (all as Account[]).find((account) => account.mine);
  };
  if ((await mine())?.status !== "connected") {
    const data = { timeZone: "UTC", acknowledged: true };
    const headers = { origin: baseURL ?? "" };
    const { url } = await (
      await page.request.post(`${accounts}/connect`, { data, headers })
    ).json();
    expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
  }
  expect((await mine())?.status).toBe("connected");
  const usageHeld = Promise.withResolvers<void>();
  let usageCalls = 0;
  await page.route(`**${accounts}/*/usage`, async (route) => {
    usageCalls += 1;
    if (usageCalls === 1) {
      return route.fulfill({ status: 404, json: { code: "sender_account_not_found" } });
    }
    await usageHeld.promise;
    return route.fallback();
  });
  let refreshed = false; // the worker's answer, which the e2e api never gets
  await page.route(`**${accounts}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const account of json.accounts as Account[]) {
      if (refreshed && account.mine) account.status = "credentials_required";
    }
    await route.fulfill({ response, json });
  });

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const usage = page.getByRole("region", { name: say("linkedin.usage.title"), exact: true });
  const usageError = usage.getByRole("alert");
  await expect(usageError).toContainText(say("linkedin.errors.sender_account_not_found"));
  await usageError.getByRole("button", { name: say("ui.action.retry") }).click();
  await expect(usage.getByRole("status")).toHaveText(say("ui.state.loading"));
  usageHeld.resolve();
  await expect(usage.getByText(say("linkedin.usage.reads_left", { left: "100" }))).toBeVisible();

  const card = page.getByRole("region", { name: "LinkedIn", exact: true });
  const disclosure = card.getByText(say("linkedin.connect.disclosure"));
  await expect(disclosure).toBeHidden();
  await card.getByText(say("linkedin.account.show_disclosure")).click();
  await expect(disclosure).toBeVisible();

  const refresh = card.getByRole("button", { name: say("linkedin.account.refresh") });
  const posted = page.waitForResponse(
    (response) => response.url().endsWith("/refresh") && response.request().method() === "POST",
  );
  await refresh.click();
  expect((await posted).status()).toBe(202);
  refreshed = true;
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  const required = say("linkedin.account.status.credentials_required");
  await expect(card.getByText(required, { exact: true })).toBeVisible();
  await expect(card.getByText(say("linkedin.account.reconnect"))).toBeVisible();
  await expect(refresh).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: say("linkedin.connect.button") })).toBeVisible();
  await expectNoSeriousViolation(page);
});
