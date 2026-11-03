// The Draft from website on the Company Knowledge screen end to end (alpha-p4-020;
// core/modules/onboarding/README.md "The screen"), on the e2e api, which runs no worker: the press
// saves the typed website and POSTs the Draft, and the progress shows while the record is fetching.
// The poll's answer is then the api's with what the worker writes (its own test,
// core/apps/worker/tests/onboarding-fetch.test.ts, reads a site): five pages listed by title; a
// blocked address, then a name that does not resolve, which read the same, never as their codes.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

// The e2e user's second workspace: company-screen.spec.ts, which may run at the same time, saves
// the first one's record, and a Draft saves the whole form.
const B = "wsp_e2e_b";
const RECORD = "**/api/v1/workspaces/*/onboarding/company-knowledge";
const messages: Record<string, string> = onboarding;
const TITLES = ["Acme Robotics", "About Acme", "The picking arm", "Pricing", "Customers"];

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** Types a website new to this run and presses Draft: the progress shows. */
async function pressDraft(page: Page) {
  const website = page.getByLabel(say("onboarding.company.source_url"), { exact: true });
  await website.fill(`https://acme-${Date.now()}.test/`);
  await page.getByRole("button", { name: say("onboarding.company.draft") }).click();
  const progress = page.locator('[data-part="website-fetch"]').getByRole("status");
  await expect(progress).toHaveText(say("onboarding.company.fetching"));
}

/** The screen's next polls answer the api's record with `change`, as the worker leaves it. */
async function workerWrites(page: Page, change: Record<string, unknown>) {
  await page.unroute(RECORD);
  await page.route(RECORD, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ...change } });
  });
}

test("Draft from website: the progress while the worker reads, then the five pages read by title; axe passes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${B}/company`);
  await pressDraft(page);
  const fetchedAt = new Date().toISOString();
  const pages = TITLES.map((title, at) => {
    const status = at === 3 ? "truncated" : "fetched";
    return { url: `https://acme.test/${at}`, title, status, fetchedAt };
  });
  await workerWrites(page, { fetchStatus: "fetched", fetchedAt, pages });
  const read = page.locator('[data-part="website-fetch"] li');
  await expect(read).toHaveCount(5);
  await expect(read.getByRole("link")).toHaveText(TITLES);
  await expect(read.nth(3)).toContainText(say("onboarding.company.page_truncated"));
  await expect(page.getByRole("heading", { level: 2, name: /^5\D/ })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});

test("a blocked address and a name that does not resolve read the same, never as their codes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${B}/company`);
  const alert = page.locator('[data-part="website-fetch"]').getByRole("alert");
  for (const code of ["egress_blocked_address", "egress_dns_failed"]) {
    await page.unroute(RECORD);
    await pressDraft(page);
    await workerWrites(page, { fetchStatus: "failed", fetchError: code, pages: [] });
    await expect(alert).toContainText(say("onboarding.errors.egress_blocked_address"));
    await expect(alert).not.toContainText("egress_");
  }
});
