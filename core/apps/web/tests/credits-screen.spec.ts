// credits' costs page and the lead page's cost line end to end (alpha-p10-010; core/modules/credits/
// README.md "Screens"), on what the e2e api's test-only module writes (core/apps/api/tests/fixtures/
// e2e) in wsp_e2e_costs, this spec's alone: two qualified leads, the week's one spend of 5 credits
// and three vendor calls, two of them the first lead's; and in wsp_e2e_nocosts, where nothing is
// ever spent. The page opened from the header's balance: the balance and its period's end, the
// week's numbers, by action and by vendor, and its usage; loading while its read is held, a read the
// api fails with the code in words and a retry, the empty week; the cost line, loading while its
// read is held, and a lead that cost nothing; the prices card (gamma-p2-060), every priced action's
// code and its PriceTag, a rise of e2e.batch announced by the e2e api's price-notice with its date,
// in the light and the dark theme, then withdrawn. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import credits from "../../../modules/credits/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_costs";
const NO_COSTS = "wsp_e2e_nocosts";
const messages: Record<string, string> = { ...credits, ...platform, ...ui };

/** The text of a key with its values, its tags dropped; a key missing from the messages fails. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value
    .replace(/<\/?\w+>/g, "")
    .replace(/\{(\w+)[^}]*\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

/** The text of a key whatever its values: for the balance, which the e2e workspaces share. */
const shaped = (key: string) =>
  new RegExp(
    `^${say(key)
      .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
      .replace(/\{\w+\}/g, ".+")}$`,
  );

const lead = (slug: string) => ({
  slug: `e2e-costs-${slug}`,
  firstName: "Cost",
  lastName: slug,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
  decision: { status: "qualified", fitScore: 90, confidence: "high", tier: "hot" },
  snapshot: {
    ...{ status: "qualified", fitScore: 90, confidence: "high", tier: "hot", icpVersion: 1 },
    summary: "Runs a data team.",
    disqualifiers: [],
    verdicts: [],
  },
});

/** POST …/e2e/<path> in the workspace, through the e2e api's test-only module. */
async function post(page: Page, origin: string | undefined, path: string, data: object) {
  const url = `/api/v1/workspaces/${WORKSPACE}/e2e/${path}`;
  const answer = await page.request.post(url, { data, headers: { origin: origin ?? "" } });
  expect(answer.status(), await answer.text()).toBe(200);
  return answer.json();
}

/** The week's Monday in UTC: the week's spend is made once, whatever the runs that week. */
function monday(): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** The week: 5 credits spent, 0.024 of vendor cost, 0.02 of it the first lead's; two qualified. */
async function seed(page: Page, origin: string | undefined): Promise<string[]> {
  const { personIds } = await post(page, origin, "leads", { leads: [lead("paid"), lead("free")] });
  await post(page, origin, "spend", { quantity: 1, key: `costs-${monday()}` });
  const [paid] = personIds as string[];
  const call = (feature: string, vendor: string, unitCost: string, subjectRef?: string) => ({
    feature,
    vendor,
    unitCost,
    ...(subjectRef ? { subjectRef } : {}),
  });
  const costs = [
    call("qualification", "example-llm", "0.012", paid),
    call("messaging", "example-llm", "0.008", paid),
    call("onboarding", "example-pages", "0.004"),
  ];
  await post(page, origin, "costs", { costs });
  return personIds;
}

/** The e2e api holds each server read of a path ending so, until cleared (tests/e2e-hold.ts). */
const hold = (context: BrowserContext, origin: string | undefined, path: string) =>
  context.addCookies([{ name: "e2e_hold", value: encodeURIComponent(path), url: origin ?? "" }]);
/** The browser's read of the week's costs, which page.route stubs. */
const isCosts = (url: URL) => url.pathname.endsWith("/credits/costs");
/** The screen's alerts: Next's route announcer is an alert too. */
const alert = (page: Page) => page.getByRole("main").getByRole("alert");
const number = (page: Page, key: string) =>
  page
    .locator("dl > div")
    .filter({ has: page.getByText(say(key), { exact: true }) })
    .locator("dd");

/** A price as GET …/credits/prices answers it. */
type Price = {
  action: string;
  next: { credits: string; unit: string; effectiveFrom: string } | null;
};

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the costs page from the header's balance: the balance, the week's numbers by action and by vendor, per 100 qualified leads, and its usage; loading, then a failed read with a retry; an empty week; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    isCosts,
    async (route) => {
      await held;
      await route.fallback();
    },
    { times: 1 },
  );
  await page.goto(`/w/${WORKSPACE}/leads`);
  await page
    .getByRole("banner")
    .getByRole("link", { name: shaped("credits.balance.label") })
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/credits$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("credits.screen.title"));
  await expect(page.getByRole("main").getByRole("status")).toHaveText(say("ui.state.loading"));
  await axe(page);
  release();

  await expect(number(page, "credits.screen.spent_credits")).toHaveText("5");
  await expect(number(page, "credits.screen.spent_money")).toHaveText("0.024");
  await expect(number(page, "credits.screen.qualified")).toHaveText("2");
  const per100 = say("credits.screen.per_100_value", { credits: "250", money: "1.2" });
  await expect(number(page, "credits.screen.per_100")).toHaveText(per100);
  await expect(page.getByText(shaped("credits.screen.available"))).toBeVisible();
  await expect(page.getByText(shaped("credits.screen.period_end"))).toBeVisible();
  const byAction = page.getByRole("table", { name: say("credits.screen.by_action") });
  await expect(byAction.locator("tbody tr")).toHaveText([/e2e\.batch\s*5/]);
  const byVendor = page.getByRole("table", { name: say("credits.screen.by_vendor") });
  await expect(byVendor.locator("tbody tr")).toHaveText([
    /example-llm\s*0\.02/,
    /example-pages\s*0\.004/,
  ]);
  const usage = page.getByRole("table", { name: say("credits.screen.usage") });
  const spent = usage.locator("tbody tr").filter({ hasText: "e2e.batch" });
  await expect(spent).toContainText(say("credits.screen.status_committed"));
  await axe(page);

  await page.route(
    isCosts,
    (route) => route.fulfill({ status: 500, json: { code: "internal_error" } }),
    {
      times: 1,
    },
  );
  await page.reload();
  await expect(alert(page)).toContainText(say("ui.state.error"));
  await expect(alert(page)).toContainText(say("platform.error.generic"));
  await axe(page);
  await alert(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  await expect(number(page, "credits.screen.spent_credits")).toHaveText("5");
  await expect(alert(page)).toHaveCount(0);

  await page.goto(`/w/${NO_COSTS}/credits`);
  await expect(page.getByText(say("credits.screen.empty"))).toBeVisible();
  await expect(page.locator("dl")).toHaveCount(0);
  await axe(page);
});

test("the lead page's cost line: loading while its read is held, then the lead's credits and vendor cost; a lead that cost nothing says so; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [paid, free] = await seed(page, baseURL);
  const cost = page.locator('[data-slot="cost"]');
  await hold(context, baseURL, `/credits/leads/${paid}/cost`);
  await page.goto(`/w/${WORKSPACE}/leads/${paid}`, { waitUntil: "commit" });
  await expect(cost.getByRole("status")).toHaveText(say("ui.state.loading"));
  await axe(page);
  await expect(cost).toHaveText(say("credits.lead_cost.line", { credits: "0", money: "0.02" }));
  await context.clearCookies({ name: "e2e_hold" });
  await axe(page);

  await page.goto(`/w/${WORKSPACE}/leads/${free}`);
  await expect(cost).toHaveText(say("credits.lead_cost.none"));
  await axe(page);
});

test("the prices card: every priced action's code and its PriceTag; during a notice, the coming price and its date, and a rise to another unit in the kit's words; withdrawn, none; axe in the light and the dark theme", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const card = page.getByRole("table", { name: say("credits.costs.prices.caption") });
  const batch = card.locator("tbody tr").filter({ hasText: "e2e.batch" });
  const coming = batch.getByText(/^From /);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  /** The route's prices, and the day e2e.batch's coming price applies from, as the page shows it. */
  const read = async () => {
    const answer = await page.request.get(`/api/v1/workspaces/${WORKSPACE}/credits/prices`);
    expect(answer.status()).toBe(200);
    const { prices } = (await answer.json()) as { prices: Price[] };
    const next = prices.find(({ action }) => action === "e2e.batch")?.next;
    // In the zone of the web and the browser, this machine's.
    const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
    return { prices, next, from: day.format(new Date(next?.effectiveFrom ?? "")) };
  };
  // A rise of e2e.batch, declared at 5 credits a lead, announced now for 30 days on; the declared
  // list again withdraws it, as the e2e api's next start would.
  await post(page, baseURL, "price-notice", { credits: "7.5" });
  try {
    const { prices, next, from } = await read();
    expect(next?.credits).toBe("7.5");
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`/w/${WORKSPACE}/credits`);
    const title = say("credits.costs.prices.title");
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(card.getByRole("columnheader")).toHaveText([
      say("credits.costs.prices.column_action"),
      say("credits.costs.prices.column_price"),
    ]);
    await expect(card.locator("tbody code")).toHaveText(prices.map(({ action }) => action));
    await expect(batch.getByText("5 credits per lead", { exact: true })).toBeVisible();
    await expect(coming).toHaveText(`From ${from}: 7.5 credits per lead`);
    await axe(page);
    const light = await background();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(background).not.toBe(light);
    await axe(page);

    // Another unit counts as a rise: a new notice, its unit named in the kit's words.
    await page.emulateMedia({ colorScheme: "light" });
    await post(page, baseURL, "price-notice", { credits: "2", unit: "batch" });
    const other = await read();
    expect(other.next).toMatchObject({ credits: "2", unit: "batch" });
    const later = (instant?: string) => Date.parse(instant ?? "");
    expect(later(other.next?.effectiveFrom)).toBeGreaterThan(later(next?.effectiveFrom));
    await page.reload();
    await expect(batch.getByText("5 credits per lead", { exact: true })).toBeVisible();
    await expect(coming).toHaveText(`From ${other.from}: 2 credits per batch`);
  } finally {
    await post(page, baseURL, "price-notice", {});
  }

  await page.reload();
  await expect(batch.getByText("5 credits per lead", { exact: true })).toBeVisible();
  await expect(coming).toHaveCount(0);
});
