// onboarding's prompt at sign-in end to end (onboarding-setup; core/modules/onboarding/README.md "The
// prompt at sign-in"), on the workspace home of the e2e api: shown to an Owner of an empty record,
// never to a Member; Build saves the website and asks for a Draft that accepts itself, then the steps
// follow the states the e2e api writes as the workers would (e2e-onboarding.ts in
// core/apps/api/tests), icp's automatic draft's included, to the summary; a reload then shows no card.
// A failed run reads in words, its Try again under a new Idempotency-Key; Skip opens the Company
// screen and hides the card in this tab only; an ICP set already ends the steps with its own line.
// axe passes, and the card fits a phone. The tests share the workspace's record, so they run in this
// file only, one after the other.
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page, Request } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const W = "wsp_e2e_get_started"; // the prompt's own workspace: no other spec writes its record
const HOME = `/w/${W}`;
const SEED = `http://127.0.0.1:${process.env.API_PORT}/test/onboarding/get-started`;
const MEMBER = "e2e-get-started-member@example.com";
const SITE = "https://corvid.test/";
const messages: Record<string, string> = { ...onboarding, ...ui };
const STEP_WAIT = { timeout: 10_000 }; // a state the e2e api wrote, read at the next poll

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

async function seed(request: APIRequestContext, state: string): Promise<void> {
  expect((await request.post(`${SEED}/${state}`)).status(), "the api must be serve:e2e").toBe(204);
}

const card = (page: Page) => page.locator('[data-part="get-started"]');
const step = (page: Page, name: string) => card(page).locator(`[data-step="${name}"]`);
const draftPost = (page: Page) =>
  page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/company-knowledge/draft"),
  );
const keyOf = (req: Request) => req.headers()["idempotency-key"];
/** The summary's value of a fact, by its label. */
const fact = (page: Page, label: string) =>
  card(page).locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");

/** The home opened and its slot rendered: then whether the card is there can be told. */
async function openHome(page: Page): Promise<void> {
  await page.goto(HOME);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** The website typed and Build pressed: the Draft's request. */
async function build(page: Page): Promise<Request> {
  await card(page).getByLabel(say("onboarding.company.source_url")).fill(SITE);
  const sent = draftPost(page);
  await card(page)
    .getByRole("button", { name: say("onboarding.get_started.build") })
    .click();
  return sent;
}

test("an Owner of an empty record is asked, a Member never; axe passes and it fits a phone; Skip opens the Company screen and hides it in this tab only", async ({
  page,
  context,
  request,
  signInAs,
  baseURL,
}, testInfo) => {
  await seed(request, "empty");
  await signInAs();
  await openHome(page);
  await expect(
    card(page).getByRole("heading", { name: say("onboarding.get_started.title") }),
  ).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .include('[data-part="get-started"]')
    .analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  const wide = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth ? [`document ${root.scrollWidth}`] : [];
  });
  expect(wide).toEqual([]);
  const box = await card(page).boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("get-started-phone.png") });

  await card(page)
    .getByRole("link", { name: say("onboarding.get_started.skip") })
    .click();
  await expect(page).toHaveURL(`${HOME}/company`);
  await openHome(page);
  await expect(card(page)).toHaveCount(0);
  const other = await context.newPage(); // another tab: its own session storage
  await openHome(other);
  await expect(card(other)).toBeVisible();

  const answer = await page.request.post(`/api/v1/workspaces/${W}/e2e/members`, {
    data: { members: [{ email: MEMBER, displayName: null, role: "Member" }] },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  await signInAs(MEMBER);
  const member = await context.newPage();
  await openHome(member);
  await expect(card(member)).toHaveCount(0);
});

test("Build saves the website and asks for a Draft that accepts itself; the steps follow the run and icp's automatic draft to the summary; Done hides the card, and a reload shows none", async ({
  page,
  request,
  signInAs,
}, testInfo) => {
  await seed(request, "empty");
  await signInAs();
  await openHome(page);
  const sent = await build(page);
  expect(sent.postDataJSON()).toEqual({ autoAccept: true });
  expect(keyOf(sent)).toMatch(/^[0-9a-f-]{36}$/);
  await expect(step(page, "reading")).toHaveAttribute("data-state", "active");
  await expect(step(page, "icp_saved")).toHaveAttribute("data-state", "next");

  await seed(request, "fetched");
  await expect(step(page, "drafting")).toHaveAttribute("data-state", "active", STEP_WAIT);
  await expect(step(page, "reading")).toHaveAttribute("data-state", "done");
  // Accepted by the run itself; icp's subscriber has not run yet: its draft reads none.
  await seed(request, "saved");
  await expect(step(page, "saved")).toHaveAttribute("data-state", "done", STEP_WAIT);
  await expect(step(page, "icp_building")).toHaveAttribute("data-state", "active");
  await seed(request, "icp-drafting");
  const drafting = await page.waitForResponse(
    async (response) =>
      response.url().endsWith("/icp/draft") && (await response.json()).status === "drafting",
  );
  expect(drafting.ok()).toBe(true);
  await expect(step(page, "icp_building")).toHaveAttribute("data-state", "active");
  await seed(request, "icp-saved");
  await expect(step(page, "icp_saved")).toHaveAttribute("data-state", "done", STEP_WAIT);

  const summary: [label: string, value: string][] = [
    ["onboarding.company.one_liner", "Corvid moves parcels for small shops."],
    ["onboarding.company.products", "2"],
    ["onboarding.company.competitors", "1"],
    ["onboarding.get_started.summary.titles", "Shop owner and Operations manager"],
    ["onboarding.get_started.summary.industries", "Retail"],
    ["onboarding.get_started.summary.countries", "Germany and France"],
  ];
  for (const [label, value] of summary) await expect(fact(page, say(label))).toHaveText(value);
  const review = (key: string) => card(page).getByRole("link", { name: say(key) });
  await expect(review("onboarding.get_started.review_company")).toHaveAttribute(
    "href",
    `${HOME}/company`,
  );
  await expect(review("onboarding.get_started.review_icp")).toHaveAttribute("href", `${HOME}/icp`);
  await card(page).screenshot({ path: testInfo.outputPath("get-started-summary.png") });
  await card(page)
    .getByRole("button", { name: say("onboarding.get_started.done") })
    .click();
  await expect(card(page)).toHaveCount(0);
  // Another tab, so that Done's hiding plays no part: the record has content now.
  const other = await page.context().newPage();
  await openHome(other);
  await expect(card(other)).toHaveCount(0);
});

test("a failed run reads in words, with Skip, and Try again asks again under a new key", async ({
  page,
  request,
  signInAs,
}) => {
  await seed(request, "empty");
  await signInAs();
  await openHome(page);
  const first = await build(page);
  await expect(step(page, "reading")).toHaveAttribute("data-state", "active");
  await seed(request, "failed");
  const alert = card(page).getByRole("alert");
  await expect(alert).toContainText(say("onboarding.company.fetch_failed"), STEP_WAIT);
  // A name that does not resolve reads as a blocked address.
  await expect(alert).toContainText(say("onboarding.errors.egress_blocked_address"));
  await expect(
    card(page).getByRole("link", { name: say("onboarding.get_started.skip") }),
  ).toBeVisible();
  await expect(card(page).getByLabel(say("onboarding.company.source_url"))).toHaveValue(SITE);
  const again = draftPost(page);
  await card(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  expect(keyOf(await again)).not.toBe(keyOf(first));
  await expect(step(page, "reading")).toHaveAttribute("data-state", "active");
});

test("an ICP set already gets no step of its own: the steps end with its line and its targeting", async ({
  page,
  request,
  signInAs,
}) => {
  await seed(request, "empty");
  await signInAs();
  // The ICP's first read makes it, empty; then it gets its targeting, before the prompt asks.
  expect((await page.request.get(`/api/v1/workspaces/${W}/icp`)).status()).toBe(200);
  await seed(request, "icp-saved");
  await openHome(page);
  await build(page);
  await expect(step(page, "reading")).toHaveAttribute("data-state", "active");
  await expect(step(page, "icp_building")).toHaveCount(0);
  await seed(request, "saved");
  await expect(card(page).getByText(say("onboarding.get_started.icp.set"))).toBeVisible(STEP_WAIT);
  const titles = fact(page, say("onboarding.get_started.summary.titles"));
  await expect(titles).toHaveText("Shop owner and Operations manager");
});
