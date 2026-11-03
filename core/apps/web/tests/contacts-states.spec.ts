// contacts' states end to end (alpha-p10-080; core/modules/contacts/README.md "Screens"), on leads
// that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in
// wsp_e2e_contacts, this spec's alone, and in wsp_e2e_noleads, which never has one: the lead list
// loading (its first read held by the e2e api, tests/e2e-hold.ts; a filter's by page.route), its
// three empty views, a read the api fails with the code in words and a retry, the Export failing
// then downloading, the file's address kept after the click; the lead page loading, its not-found
// state, a needs_review lead's unknown criteria, a disqualifier and the why in qualification's
// words, a key the bundle lacks shown as nothing on the page and in the list; a slot loading while
// its panel answers, a failed one with the code in words and a retry that renders it again, and a
// panel's notFound() past the slot. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import fixture from "./fixtures/modules/fixture/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_contacts";
const NO_LEADS = "wsp_e2e_noleads";
const messages: Record<string, string> = {
  ...contacts,
  ...qualification,
  ...platform,
  ...ui,
  ...web,
  ...fixture,
};

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const person = (slug: string, lastName: string) => ({
  slug: `e2e-states-${slug}`,
  firstName: "State",
  lastName,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
});
const qualified = (slug: string, fitScore: number, tier: string) => ({
  ...person(slug, slug),
  decision: { status: "qualified", fitScore, confidence: "high", tier },
});
const verdict = (criterion: string, value: string) => ({
  criterion,
  verdict: value,
  evidence: "",
  weight: 10,
  points: value === "met" ? 1 : 0,
});
const CRITERIA = ["title_function", "seniority", "company_size", "industry", "location"];
/** A lead the model could not judge on company size and location; its first why key is retired. */
const unsure = {
  ...person("unsure", "Unsure"),
  decision: {
    status: "needs_review",
    fitScore: 66,
    confidence: "low",
    tier: "warm",
    why: [
      { key: "qualification.why.retired_bullet" },
      { key: "qualification.why.gap", params: { criterion: "company_size", more: 1 } },
    ],
  },
  snapshot: {
    ...{ status: "needs_review", fitScore: 66, confidence: "low", tier: "warm", icpVersion: 1 },
    summary: "Leads a data team; the profile names no company size or location.",
    disqualifiers: [],
    verdicts: CRITERIA.map((criterion) =>
      verdict(criterion, ["company_size", "location"].includes(criterion) ? "unknown" : "met"),
    ),
  },
};
/** A recruiter, whom qualification's disqualifier stopped. */
const stopped = {
  ...person("stopped", "Stopped"),
  decision: { status: "not_qualified", fitScore: 40, confidence: "high", tier: "cool" },
  snapshot: {
    ...{ status: "not_qualified", fitScore: 40, confidence: "high", tier: "cool", icpVersion: 1 },
    summary: "Hires data engineers for clients.",
    disqualifiers: ["recruiter"],
    verdicts: CRITERIA.map((criterion) => verdict(criterion, "met")),
  },
};

/** Replaces the workspace's leads with these, through the e2e api's test-only route; their ids. */
async function seed(page: Page, origin: string | undefined, leads: readonly object[]) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

/** The e2e api holds each server read of a path ending so, until cleared (tests/e2e-hold.ts). */
const hold = (context: BrowserContext, origin: string | undefined, path: string) =>
  context.addCookies([{ name: "e2e_hold", value: encodeURIComponent(path), url: origin ?? "" }]);
/** What the fixture's panel in the draft slot does (its ui/failing/panel.tsx). */
const panelDoes = (context: BrowserContext, origin: string | undefined, value: string) =>
  context.addCookies([{ name: "fixture_panel", value, url: origin ?? "" }]);
/** The browser's reads of the list, which page.route stubs. */
const isList = (url: URL) => url.pathname.endsWith("/contacts/leads");
const rows = (page: Page) => page.locator("tbody tr");
const status = (page: Page, key: string) => page.getByRole("status").filter({ hasText: say(key) });
/** The screen's alerts: Next's route announcer is an alert too. */
const alert = (page: Page) => page.getByRole("main").getByRole("alert");

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the list loading at its first read and at a filter, then its leads; a workspace without a lead links to the sources and the import; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, [qualified("hot", 90, "hot"), qualified("warm", 70, "warm")]);
  await hold(context, baseURL, "/contacts/leads/counts");
  await page.goto(`/w/${WORKSPACE}/leads`, { waitUntil: "commit" });
  await expect(status(page, "contacts.leads.loading")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("contacts.leads.title"));
  await axe(page);
  await expect(rows(page)).toHaveCount(2);
  await context.clearCookies({ name: "e2e_hold" });

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    isList,
    async (route) => {
      await held;
      await route.fallback();
    },
    { times: 1 },
  );
  await page.getByLabel(say("contacts.leads.filter.tier"), { exact: true }).selectOption("hot");
  await expect(status(page, "contacts.leads.loading")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await axe(page);
  release();
  await expect(rows(page)).toHaveCount(1);
  await expect(status(page, "contacts.leads.loading")).toHaveCount(0);

  await page.goto(`/w/${NO_LEADS}/leads`);
  await expect(page.getByText(say("contacts.leads.empty.none"))).toBeVisible();
  const sources = page.getByRole("link", { name: say("contacts.leads.links.sources") });
  await expect(sources).toHaveAttribute("href", `/w/${NO_LEADS}/sources`);
  const imports = page.getByRole("link", { name: say("contacts.leads.links.import") });
  await expect(imports).toHaveAttribute("href", `/w/${NO_LEADS}/import`);
  await axe(page);
});

test("the list's empty views say why: none in this status and tier, none left to review; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const ids = await seed(page, baseURL, [qualified("one", 90, "hot"), qualified("two", 80, "hot")]);
  for (const id of ids) {
    const answer = await page.request.post(
      `/api/v1/workspaces/${WORKSPACE}/contacts/leads/${id}/review`,
      {
        data: { decision: "good_lead", goodReasonText: "Runs the data team" },
        headers: { origin: baseURL ?? "" },
      },
    );
    expect(answer.status(), await answer.text()).toBe(201);
  }
  await page.goto(`/w/${WORKSPACE}/leads`);
  await expect(rows(page)).toHaveCount(2);
  const statuses = page.getByLabel(say("contacts.leads.filter.status"), { exact: true });
  await statuses.selectOption("pending");
  await expect(page.getByText(say("contacts.leads.empty.status"))).toBeVisible();
  await expect(page.getByText(say("contacts.leads.empty.none"))).toHaveCount(0);
  await axe(page);
  await statuses.selectOption("qualified");
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel(say("contacts.leads.filter.review"), { exact: true }).check();
  await expect(page.getByText(say("contacts.leads.empty.unreviewed"))).toBeVisible();
  await axe(page);
});

test("a list read the api fails shows the code in words and a retry, which reads it again; Export fails the same way, its retry downloads the file, and the file's address outlives the click; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, [qualified("hot", 90, "hot"), qualified("warm", 70, "warm")]);
  // The blob URLs the page revokes.
  await page.addInitScript(() => {
    const revoked: string[] = [];
    Object.assign(window, { revoked });
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      revoke(url);
    };
  });
  await page.goto(`/w/${WORKSPACE}/leads`);
  await expect(rows(page)).toHaveCount(2);
  const refused = { status: 400, json: { code: "contacts_input_invalid" } };
  await page.route(isList, (route) => route.fulfill(refused), { times: 1 });
  await page.getByLabel(say("contacts.leads.filter.tier"), { exact: true }).selectOption("hot");
  await expect(page.getByText(say("contacts.leads.error"), { exact: true })).toBeVisible();
  await expect(alert(page)).toContainText(say("ui.state.error"));
  await expect(alert(page)).toContainText(say("contacts.errors.contacts_input_invalid"));
  await axe(page);
  await alert(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  await expect(rows(page)).toHaveCount(1);
  await expect(alert(page)).toHaveCount(0);

  const csv = (url: URL) => url.pathname.endsWith("/exports/leads.csv");
  const failed = { status: 500, json: { code: "internal_error" } };
  await page.route(csv, (route) => route.fulfill(failed), { times: 1 });
  await page.getByRole("button", { name: say("contacts.leads.export") }).click();
  await expect(alert(page)).toContainText(say("ui.state.error"));
  await expect(alert(page)).toContainText(say("platform.error.generic"));
  await axe(page);
  const downloaded = page.waitForEvent("download");
  await alert(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(alert(page)).toHaveCount(0);
  // Revoked on the next tick, the address could be gone before Firefox or Safari reads the file.
  await page.waitForTimeout(1_000);
  const revoked = await page.evaluate(() => (window as unknown as { revoked: string[] }).revoked);
  expect(revoked).toEqual([]);
});

test("the lead page loading, then a needs_review lead with its unknown criteria under its name; a disqualifier in qualification's words; a why key the bundle lacks is nothing, on the page and in the list; a person without a lead is the not-found state; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [unsureId, stoppedId] = await seed(page, baseURL, [unsure, stopped]);
  await hold(context, baseURL, `/contacts/leads/${unsureId}/neighbours`);
  await page.goto(`/w/${WORKSPACE}/leads/${unsureId}`, { waitUntil: "commit" });
  await expect(status(page, "contacts.lead.loading")).toBeVisible();
  // The lead read first names the document.
  await expect(page).toHaveTitle("State Unsure");
  await axe(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("State Unsure");
  await context.clearCookies({ name: "e2e_hold" });
  const criteria = [
    say("qualification.criterion.company_size"),
    say("qualification.criterion.location"),
  ].join(" and ");
  const unknown = say("contacts.lead.unknown_criterion")
    .replace("{criteria}", criteria)
    .replace(/\{count, plural, one \{[^}]*\} other \{([^}]*)\}\}/, "$1");
  await expect(page.getByText(unknown, { exact: true })).toBeVisible();
  // The retired key's bullet is left out, the other one is in qualification's words.
  const why = page.getByRole("region", { name: say("contacts.lead.why") }).getByRole("listitem");
  await expect(why).toHaveText(["Not enough data on company size and 1 more criterion"]);
  await axe(page);

  await page.goto(`/w/${WORKSPACE}/leads/${stoppedId}`);
  const disqualifiers = page.getByRole("region", { name: say("contacts.lead.disqualifiers") });
  await expect(disqualifiers.getByRole("listitem")).toHaveText([
    say("qualification.disqualifier.recruiter"),
  ]);
  await expect(page.getByText(unknown)).toHaveCount(0);

  await page.goto(`/w/${WORKSPACE}/leads?status=needs_review`);
  await expect(rows(page)).toHaveCount(1);
  // The why column, the sixth cell after the row's name, shows the first bullet, whose key is
  // retired: nothing, as on the page.
  await expect(page.locator("thead th").nth(6)).toHaveText(say("contacts.leads.columns.why"));
  await expect(rows(page).first().locator("td").nth(5)).toHaveText("");

  await page.goto(`/w/${WORKSPACE}/leads/per_00000000000000000000000000?status=needs_review`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("contacts.lead.not_found"));
  await expect(page.getByText(say("contacts.errors.lead_not_found"))).toBeVisible();
  await expect(page.getByRole("link", { name: say("contacts.lead.back") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/leads?status=needs_review&sort=fit`,
  );
  await axe(page);
});

test("a slot loading while its panel answers, then the panel; a failed slot shows the code in words and a retry that renders it again; a panel's notFound() passes the slot to the not-found page; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [id] = await seed(page, baseURL, [qualified("slots", 88, "hot")]);
  const draft = page.locator('[data-slot="draft"]');
  await panelDoes(context, baseURL, "wait");
  await page.goto(`/w/${WORKSPACE}/leads/${id}`, { waitUntil: "commit" });
  await expect(draft.getByRole("status")).toHaveText(say("ui.state.loading"));
  await axe(page);
  // The fixture's line; the slot holds messaging's draft panel too (its ui/nav.ts).
  await expect(draft.getByText(say("fixture.failing.body"), { exact: true })).toBeVisible();

  await panelDoes(context, baseURL, "throw");
  await page.reload();
  await expect(draft.locator("p").first()).toHaveText(say("contacts.lead.slot_failed"));
  await expect(draft.getByRole("alert")).toContainText(say("ui.state.error"));
  await expect(draft.getByRole("alert")).toContainText(say("platform.error.generic"));
  // The rest of the page stands.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("State slots");
  await axe(page);
  await panelDoes(context, baseURL, "wait");
  await draft.getByRole("button", { name: say("ui.action.retry") }).click();
  // The page read again: the slot waits on its panel, then shows it.
  await expect(draft.getByRole("status")).toHaveText(say("ui.state.loading"));
  await expect(draft.getByText(say("fixture.failing.body"), { exact: true })).toBeVisible();
  await expect(draft.getByRole("alert")).toHaveCount(0);

  await panelDoes(context, baseURL, "not_found");
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("web.not_found.title"));
  await expect(draft).toHaveCount(0);
});
