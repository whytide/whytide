// contacts' lead list (alpha-p6-050; core/modules/contacts/README.md "Screens") on leads that the e2e
// api's test-only routes write through contacts' commands (core/apps/api/tests/fixtures/e2e): by fit,
// twenty a page, the filters, a row's link, the source's links (fix-lead-source-post), the empty
// state, axe and the keyboard; and credits' balance in the header, after a reserve and its commit
// of credits' own, as a batch spends them.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import fixture from "./fixtures/modules/fixture/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

// The one workspace the api's fixture module knows; its leads are this spec's alone.
const WORKSPACE = "wsp_fixture_a";
const messages: Record<string, string> = { ...contacts, ...ui, ...fixture };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

type Seed = {
  slug: string;
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  source: "imported" | "signal";
  /** The lead's sources, as createLeadForPerson takes them; one of `source`'s kind without. */
  sources?: Record<string, string>[];
  decision?: Record<string, unknown>;
};
const person = (slug: string, lastName: string, source: Seed["source"] = "imported") => ({
  slug,
  firstName: "Lead",
  lastName,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source,
});
/** Twenty-five qualified leads, fit 99 down to 51 by two: thirteen hot, seven warm, five cool. */
const qualified: Seed[] = Array.from({ length: 25 }, (_, index) => {
  const fitScore = 99 - 2 * index;
  const tier = fitScore >= 75 ? "hot" : fitScore >= 60 ? "warm" : "cool";
  const why = [{ key: "fixture.why.match", params: { title: "Head of Data" } }];
  const number = String(index + 1).padStart(2, "0");
  const source = index % 2 === 0 ? "imported" : "signal";
  const decision = { status: "qualified", fitScore, confidence: "high", tier, why };
  return { ...person(`e2e-lead-${number}`, number, source), decision };
});
const gap = (field: string) => [{ key: "fixture.why.data_gap", params: { field } }];
const others: Seed[] = [
  {
    ...person("e2e-review-1", "R1"),
    decision: { status: "needs_review", fitScore: 70, confidence: "low", why: gap("company size") },
  },
  {
    ...person("e2e-review-2", "R2"),
    decision: { status: "needs_review", fitScore: 65, confidence: "low", why: gap("location") },
  },
  { ...person("e2e-failed", "F1"), decision: { status: "ai_failed", reason: "length" } },
];

/** The e2e api's test-only routes for WORKSPACE, from the web's origin. */
function e2e(page: Page, origin: string | undefined) {
  const post = async (path: string, data: unknown) => {
    const url = `/api/v1/workspaces/${WORKSPACE}/e2e/${path}`;
    const answer = await page.request.post(url, { data, headers: { origin: origin ?? "" } });
    expect(answer.status(), await answer.text()).toBe(200);
    return answer.json();
  };
  return {
    /** Replaces the workspace's leads with these; their person ids, in this order. */
    seed: async (leads: Seed[]) =>
      ((await post("leads", { leads })) as { personIds: string[] }).personIds,
    /** `quantity` units of e2e.batch, 5 credits each, reserved and committed by credits. */
    spend: (quantity: number) => post("spend", { quantity }),
  };
}

const rows = (page: Page) => page.locator("tbody tr");
/** The text of each row's cell in the column, 1 for tier, the name being the row's header. */
const column = (page: Page, index: number) =>
  rows(page).locator(`td:nth-of-type(${index})`).allTextContents();
const fits = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => String(from - 2 * index));

test("qualified leads by descending fit, twenty a page, with the columns; the tier filter; axe and the keyboard", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { seed } = e2e(page, baseURL);
  const ids = await seed([...qualified, ...others]);
  await page.goto(`/w/${WORKSPACE}/leads`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("contacts.leads.title"));
  const counts = {
    qualified: 25,
    needs_review: 2,
    not_qualified: 0,
    hard_filtered: 0,
    ai_failed: 1,
    pending: 0,
  };
  // The counts, a pill per status in the list's order.
  const pills = page.getByRole("list", { name: say("contacts.leads.counts_label") });
  await expect(pills.getByRole("listitem")).toHaveText(
    Object.entries(counts).map(
      ([status, count]) => `${say(`contacts.leads.status.${status}`)} ${count}`,
    ),
  );
  // The view's own pill is current, for assistive technology as by its colour.
  const current = pills.locator('[aria-current="true"]');
  await expect(current).toHaveText(`${say("contacts.leads.status.qualified")} 25`);
  // The name's cell holds the title at the company under it: one column, for the table to fit.
  const headers = ["name", "tier", "fit", "confidence", "source"];
  await expect(page.locator("thead th")).toHaveText(
    [...headers, "qualified_at", "why", "review"].map((key) =>
      say(`contacts.leads.columns.${key}`),
    ),
  );
  await expect(rows(page)).toHaveCount(20);
  expect(await column(page, 2)).toEqual(fits(99, 20));
  await expect(rows(page).first().locator("th, td")).toHaveText([
    "Lead 01 Head of Data at Blue Harbor Labs",
    say("ui.tier.hot"),
    "99",
    say("contacts.leads.confidence.high"),
    say("contacts.leads.source.imported"),
    /\d/,
    "Head of Data is a title the ICP wants",
    "",
  ]);

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking).toEqual([]);

  const pager = page.getByRole("navigation", { name: say("ui.table.pages") });
  const previous = pager.getByRole("button", { name: say("ui.table.previous") });
  const next = pager.getByRole("button", { name: say("ui.table.next") });
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await next.press("Enter");
  await expect(rows(page)).toHaveCount(5);
  expect(await column(page, 2)).toEqual(fits(59, 5));
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await previous.press("Enter");
  await expect(rows(page)).toHaveCount(20);

  await page.getByLabel(say("contacts.leads.filter.tier")).selectOption("hot");
  await expect(rows(page)).toHaveCount(13);
  expect(await column(page, 1)).toEqual(Array(13).fill(say("ui.tier.hot")));
  expect(await column(page, 2)).toEqual(fits(99, 13));

  const newest = page.getByRole("button", { name: say("contacts.leads.columns.qualified_at") });
  await newest.press("Enter");
  const sorted = page.getByRole("columnheader", {
    name: say("contacts.leads.columns.qualified_at"),
  });
  await expect(sorted).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("[aria-busy]")).toHaveCount(0);
  await page.keyboard.press("Tab");
  const link = rows(page).first().getByRole("link");
  await expect(link).toBeFocused();
  // The link carries the view to the lead page (alpha-p6-060): its filters and sort.
  const href = await link.getAttribute("href");
  const view = "?status=qualified&tier=hot&sort=newest";
  expect(ids.map((id) => `/w/${WORKSPACE}/leads/${id}${view}`)).toContain(href);
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => `${url.pathname}${url.search}` === href);
});

test("the status filter shows needs_review leads with their data-gap bullet, ai_failed ones with the reason", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { seed } = e2e(page, baseURL);
  await seed([...qualified, ...others]);
  await page.goto(`/w/${WORKSPACE}/leads`);
  const status = page.getByLabel(say("contacts.leads.filter.status"));
  await status.selectOption("needs_review");
  await expect(rows(page)).toHaveCount(2);
  const why = rows(page).locator("td:nth-of-type(6)");
  await expect(why).toHaveText(["No company size on the profile", "No location on the profile"]);
  await status.selectOption("ai_failed");
  await expect(rows(page)).toHaveCount(1);
  await expect(why).toHaveText("Assessment failed: the answer was cut short.");
});

test("the source: a signal source's label linked to its post in a new tab, a signal without one linked to its runs, the most recent of several with +N naming the others; above the row's link; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { seed } = e2e(page, baseURL);
  const post = "https://posts.example/launch";
  const lead = (slug: string, fitScore: number, sources: Record<string, string>[]) => ({
    ...person(`e2e-source-${slug}`, slug, "signal"),
    sources,
    decision: { status: "qualified", fitScore, confidence: "high", tier: "hot" },
  });
  const at = (day: number) => `2026-10-0${day}T08:00:00.000Z`;
  await seed([
    lead("named", 90, [{ kind: "signal", ref: "src_named", label: "Launch post", url: post }]),
    lead("bare", 80, [{ kind: "signal", ref: "src_bare" }]),
    lead("many", 70, [
      { kind: "imported", ref: "imp_1", at: at(1) },
      { kind: "signal", ref: "src_new", label: "New post", url: `${post}-new`, at: at(5) },
      { kind: "signal", ref: "src_old", label: "Old post", url: `${post}-old`, at: at(2) },
    ]),
  ]);
  await page.goto(`/w/${WORKSPACE}/leads`);
  const cells = rows(page).locator("td:nth-of-type(4)");
  await expect(cells).toHaveCount(3);

  const named = cells.nth(0).getByRole("link", { name: "Launch post" });
  await expect(named).toHaveAttribute("href", post);
  await expect(named).toHaveAttribute("target", "_blank");
  await expect(named).toHaveAttribute("rel", "noreferrer");
  // The pointer reaches the link, not the row's link over the row; nothing is opened.
  await named.click({ trial: true });

  const bare = cells.nth(1).getByRole("link", { name: say("contacts.leads.source.signal") });
  await expect(bare).toHaveAttribute("href", `/w/${WORKSPACE}/sources?runs=src_bare`);
  await bare.click({ trial: true });

  const many = cells.nth(2);
  await expect(many.getByRole("link")).toHaveAttribute("href", `${post}-new`);
  await expect(many.locator('[aria-hidden="true"]')).toHaveText(
    say("contacts.leads.source.more").replace("{count, number}", "2"),
  );
  const imported = say("contacts.leads.source.imported");
  const others = new Intl.ListFormat("en", { type: "unit" }).format([imported, "Old post"]);
  const title = say("contacts.leads.source.others").replace("{sources}", others);
  await expect(many.locator("[title]")).toHaveAttribute("title", title);
  await many.locator("[title]").hover({ trial: true });

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking).toEqual([]);
});

test("the header shows the balance, lower after a batch has spent credits: at the reload and at the next page", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { spend } = e2e(page, baseURL);
  // The organization's grant for the period comes with the first spend (the e2e api has no worker).
  await spend(1);
  await page.goto(`/w/${WORKSPACE}/leads`);
  const balance = page.locator('[data-slot="balance"]');
  await expect(balance).toHaveText(/^[\d,]+ credits$/);
  const amount = async () => Number((await balance.textContent())?.replace(/\D/g, ""));
  const before = await amount();
  await spend(2);
  await page.reload();
  await expect.poll(amount).toBe(before - 10);
  await spend(1);
  await page.getByRole("link", { name: say("fixture.nav.greeting") }).click();
  await page.waitForURL((url) => url.pathname === `/w/${WORKSPACE}/fixture`);
  await expect.poll(amount).toBe(before - 15);
});

test("a row links to its lead page; with no lead, the empty state links to the sources and the import", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { seed } = e2e(page, baseURL);
  const [first] = await seed(qualified.slice(0, 1));
  await page.goto(`/w/${WORKSPACE}/leads`);
  const link = page.getByRole("table").getByRole("link", { name: "Lead 01" });
  const view = "?status=qualified&sort=fit";
  await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/leads/${first}${view}`);
  await seed([]);
  await page.reload();
  await expect(page.getByText(say("contacts.leads.empty.none"))).toBeVisible();
  const sources = page.getByRole("link", { name: say("contacts.leads.links.sources") });
  await expect(sources).toHaveAttribute("href", `/w/${WORKSPACE}/sources`);
  const imports = page.getByRole("link", { name: say("contacts.leads.links.import") });
  await expect(imports).toHaveAttribute("href", `/w/${WORKSPACE}/import`);
});
