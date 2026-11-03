// The lead list's view in its address (alpha-p10-080; core/modules/contacts/README.md "Screens"),
// on leads that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in
// wsp_e2e_url, this spec's alone: each filter and the sort written into the address as it changes,
// Back and Forward within the list, a reload and Back after it returning to each view; the
// "unreviewed first" sort, from the Sort select; and the lead page's previous and next following
// the list's filters and sort, its way back and the browser's Back returning to the list's view.
// Axe on both screens.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_url";
const LIST = `/w/${WORKSPACE}/leads`;
const messages: Record<string, string> = contacts;

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const lead = (slug: string, fitScore: number, tier: string) => ({
  slug: `e2e-url-${slug}`,
  firstName: "Url",
  lastName: slug,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
  decision: { status: "qualified", fitScore, confidence: "high", tier },
});
/** Five qualified leads, by descending fit: two hot, two warm, one cool. */
const LEADS = [
  lead("a", 90, "hot"),
  lead("b", 85, "hot"),
  lead("c", 70, "warm"),
  lead("d", 65, "warm"),
  lead("e", 55, "cool"),
];

/** Replaces the workspace's leads with LEADS, through the e2e api's test-only route; their ids. */
async function seed(page: Page, origin: string | undefined) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: LEADS },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: [string, string, string, string, string] })
    .personIds;
}

/** A review decision on the lead, through contacts' route. */
async function review(page: Page, origin: string | undefined, personId: string, body: object) {
  const answer = await page.request.post(
    `/api/v1/workspaces/${WORKSPACE}/contacts/leads/${personId}/review`,
    { data: body, headers: { origin: origin ?? "" } },
  );
  expect(answer.status(), await answer.text()).toBe(201);
}

const rows = (page: Page) => page.locator("tbody tr");
const leadPath = (personId: string, query: string) => `${LIST}/${personId}${query}`;
/** The list's row links open these lead pages, in this order. */
async function expectRows(page: Page, hrefs: readonly string[]) {
  const links = page.locator("tbody tr a");
  await expect(links).toHaveCount(hrefs.length);
  for (const [index, href] of hrefs.entries()) {
    await expect(links.nth(index)).toHaveAttribute("href", href);
  }
}
/** The page's address is the list's with this query. */
const listAt = (page: Page, query: string) =>
  expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === `${LIST}${query}`);
const controls = (page: Page) => ({
  tier: page.getByLabel(say("contacts.leads.filter.tier"), { exact: true }),
  unreviewed: page.getByLabel(say("contacts.leads.filter.review"), { exact: true }),
  sort: page.getByLabel(say("contacts.leads.sort.label"), { exact: true }),
});
const around = (page: Page) => {
  const nav = page.getByRole("navigation", { name: say("contacts.lead.navigation") });
  return {
    back: nav.getByRole("link", { name: say("contacts.lead.back") }),
    previous: nav.getByRole("link", { name: say("contacts.lead.previous") }),
    next: nav.getByRole("link", { name: say("contacts.lead.next") }),
  };
};

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the list writes each filter and its sort into its address; Back and Forward within the list, a reload, and Back after it return to each view; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [a, b] = await seed(page, baseURL);
  await page.goto(LIST);
  await expect(rows(page)).toHaveCount(5);
  const { tier, unreviewed, sort } = controls(page);
  const hotByFit = "?status=qualified&tier=hot&sort=fit";
  const hotByNewest = "?status=qualified&tier=hot&sort=newest";
  const view = `${hotByNewest}&review=unreviewed`;

  await tier.selectOption("hot");
  await listAt(page, hotByFit);
  await expectRows(
    page,
    [a, b].map((id) => leadPath(id, hotByFit)),
  );
  await sort.selectOption("newest");
  await listAt(page, hotByNewest);
  await expect(page.locator(`tbody tr a[href$="${hotByNewest}"]`)).toHaveCount(2);
  // Back and Forward between the list's own entries: it reads the address's view again.
  await page.goBack();
  await listAt(page, hotByFit);
  await expect(sort).toHaveValue("fit");
  await expectRows(
    page,
    [a, b].map((id) => leadPath(id, hotByFit)),
  );
  await page.goForward();
  await listAt(page, hotByNewest);
  await expect(sort).toHaveValue("newest");
  await expect(page.locator(`tbody tr a[href$="${hotByNewest}"]`)).toHaveCount(2);
  await unreviewed.check();
  await listAt(page, view);
  await expect(page.locator(`tbody tr a[href$="${view}"]`)).toHaveCount(2);

  await page.reload();
  await expect(tier).toHaveValue("hot");
  await expect(sort).toHaveValue("newest");
  await expect(unreviewed).toBeChecked();
  // Both hot leads, newest first: an order this spec leaves to the api.
  for (const id of [a, b]) {
    await expect(page.locator(`tbody tr a[href="${leadPath(id, view)}"]`)).toHaveCount(1);
  }
  await axe(page);
  await page.goBack();
  await listAt(page, hotByNewest);
  await expect(unreviewed).not.toBeChecked();
  await expect(sort).toHaveValue("newest");
  await page.goBack();
  await listAt(page, hotByFit);
  await expect(sort).toHaveValue("fit");
  await page.goBack();
  await listAt(page, "");
  await expect(tier).toHaveValue("");
  await expect(rows(page)).toHaveCount(5);
  await page.goForward();
  await listAt(page, hotByFit);
  await expect(tier).toHaveValue("hot");
  await expectRows(
    page,
    [a, b].map((id) => leadPath(id, hotByFit)),
  );
});

test("Unreviewed first puts the leads without a decision first, by fit, then Good lead, then Not a fit; the lead page's previous and next follow the list's sort and filters; its way back and the browser's Back return to the list's view; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [a, b, c, d, e] = await seed(page, baseURL);
  await review(page, baseURL, a, { decision: "good_lead", goodReasonText: "Runs the data team" });
  await review(page, baseURL, c, { decision: "not_a_fit", reasonCode: "contact_left_company" });
  await page.goto(LIST);
  await expect(rows(page)).toHaveCount(5);
  const { tier, unreviewed, sort } = controls(page);
  const { back, previous, next } = around(page);

  await sort.selectOption("unreviewed_first");
  const first = "?status=qualified&sort=unreviewed_first";
  await listAt(page, first);
  const firstRows = [b, d, e, a, c].map((id) => leadPath(id, first));
  await expectRows(page, firstRows);
  const column = page.getByRole("columnheader", { name: say("contacts.leads.columns.review") });
  await expect(column).toHaveAttribute("aria-sort", "ascending");
  await axe(page);

  await page.locator("tbody tr a").nth(1).click();
  await page.waitForURL((url) => url.pathname === `${LIST}/${d}`);
  await expect(previous).toHaveAttribute("href", leadPath(b, first));
  await expect(next).toHaveAttribute("href", leadPath(e, first));
  await axe(page);
  await next.click();
  await page.waitForURL((url) => url.pathname === `${LIST}/${e}`);
  // The last lead without a decision, then the Good lead, then the Not a fit.
  await expect(next).toHaveAttribute("href", leadPath(a, first));
  await next.click();
  await page.waitForURL((url) => url.pathname === `${LIST}/${a}`);
  await expect(next).toHaveAttribute("href", leadPath(c, first));
  await next.click();
  await page.waitForURL((url) => url.pathname === `${LIST}/${c}`);
  await expect(previous).toHaveAttribute("href", leadPath(a, first));
  await expect(next).toHaveCount(0);
  await back.click();
  await listAt(page, first);
  await expect(sort).toHaveValue("unreviewed_first");
  await expectRows(page, firstRows);

  // The filters too: warm leads without a decision, then every lead without one, by fit.
  await sort.selectOption("fit");
  await tier.selectOption("warm");
  await unreviewed.check();
  const warm = "?status=qualified&tier=warm&sort=fit&review=unreviewed";
  await listAt(page, warm);
  await expectRows(page, [leadPath(d, warm)]);
  await tier.selectOption("");
  const all = "?status=qualified&sort=fit&review=unreviewed";
  await listAt(page, all);
  await expectRows(
    page,
    [b, d, e].map((id) => leadPath(id, all)),
  );
  await page.locator("tbody tr a").nth(1).click();
  await page.waitForURL((url) => url.pathname === `${LIST}/${d}`);
  // c, between b and d by fit, has a decision: the filter leaves it out.
  await expect(previous).toHaveAttribute("href", leadPath(b, all));
  await expect(next).toHaveAttribute("href", leadPath(e, all));
  await page.goBack();
  await listAt(page, all);
  await expect(unreviewed).toBeChecked();
  await expect(tier).toHaveValue("");
  await expectRows(
    page,
    [b, d, e].map((id) => leadPath(id, all)),
  );
});
