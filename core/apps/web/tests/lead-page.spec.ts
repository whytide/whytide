// contacts' lead page (alpha-p6-060; core/modules/contacts/README.md "Screens") on leads and their
// snapshots that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e), in the e2e
// users' second workspace, whose leads are this spec's alone (lead-list.spec.ts seeds the fixture's):
// a qualified lead's fields with their sources, its decision and why in qualification's words, the
// summary under its label, the verdicts behind a disclosure, the fixture module's panel in the
// evidence slot, axe and the keyboard; a hard-filtered lead and an ai_failed one; the neighbours in
// the list's view; the not-found state for another workspace's person and for one without a lead.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import fixture from "./fixtures/modules/fixture/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_b";
const messages: Record<string, string> = {
  ...contacts,
  ...qualification,
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

/** contacts.lead.provenance of an imported field, its date in the medium style. */
const FROM_IMPORT = String.raw`From an import, \w{3} \d{1,2}, \d{4}`;
const DATE = /^\w{3} \d{1,2}, \d{4}$/;

const person = (slug: string, lastName: string) => ({
  slug: `e2e-page-${slug}`,
  firstName: "Page",
  lastName,
  headline: "Data leader at a software company",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  locationText: "Lisbon, Portugal",
  source: "imported",
});
const qualified = (fitScore: number, tier: string) => ({
  status: "qualified",
  fitScore,
  confidence: "high",
  tier,
  icpVersion: 2,
});
/** The six verdicts in the criteria's order, the page's. */
const VERDICTS = [
  { criterion: "title_function", verdict: "met", evidence: "Head of Data", weight: 30, points: 1 },
  { criterion: "seniority", verdict: "met", evidence: "Head of Data", weight: 15, points: 1 },
  { criterion: "company_size", verdict: "unknown", evidence: "", weight: 10, points: 0.4 },
  { criterion: "industry", verdict: "met", evidence: "Software", weight: 15, points: 1 },
  {
    criterion: "location",
    verdict: "not_met",
    evidence: "Lisbon, Portugal",
    weight: 10,
    points: 0,
  },
  { criterion: "must_haves", verdict: "met", evidence: "Runs a data team", weight: 20, points: 1 },
];
const SUMMARY = "Leads the data team of a software company that the ICP describes.";
/**
 * Three bullets, the most a lead keeps, in the keys qualification writes: fit-v1 writes two at most
 * for a qualified lead (a missed must is never qualified), and the page shows what the lead stores.
 */
const WHY = [
  {
    key: "qualification.why.must_missed",
    params: { criterion: "location", quote: "Lisbon, Portugal" },
  },
  {
    key: "qualification.why.fit",
    params: { criterion: "title_function", quote: "Head of Data", met: 4, total: 6 },
  },
  { key: "qualification.why.gap", params: { criterion: "company_size", more: 0 } },
];
const hot = {
  ...person("hot", "Hot"),
  decision: { ...qualified(82, "hot"), why: WHY },
  snapshot: { ...qualified(82, "hot"), summary: SUMMARY, disqualifiers: [], verdicts: VERDICTS },
};
const warm = { ...person("warm", "Warm"), decision: qualified(64, "warm") };
const cool = { ...person("cool", "Cool"), decision: qualified(55, "cool") };
const filtered = {
  ...person("filtered", "Filtered"),
  title: "Recruiter",
  decision: {
    status: "hard_filtered",
    reason: "title_mismatch",
    why: [
      {
        key: "qualification.why.hard_filtered",
        params: { reason: "title_mismatch", value: "Recruiter", icp: "Head of Data, VP Data" },
      },
    ],
  },
};
const failed = {
  ...person("failed", "Failed"),
  decision: { status: "ai_failed", reason: "length" },
};

/** Replaces the workspace's leads with these, through the e2e api's test-only route; their ids. */
async function seed<const Leads extends readonly object[]>(
  page: Page,
  origin: string | undefined,
  leads: Leads,
) {
  const url = `/api/v1/workspaces/${WORKSPACE}/e2e/leads`;
  const answer = await page.request.post(url, {
    data: { leads },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: { [K in keyof Leads]: string } }).personIds;
}

const leadPath = (personId: string, query = "") => `/w/${WORKSPACE}/leads/${personId}${query}`;
const section = (page: Page, key: string) => page.getByRole("region", { name: say(key) });
/** The hrefs of the list's row links, in the rows' order. */
const rowLinks = (page: Page) =>
  page.locator("tbody tr a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));

test("a qualified lead: its fields with their sources, the decision and three why bullets in qualification's words, the summary under its label, six verdicts opened by the keyboard, the LinkedIn link, the fixture's evidence panel; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [id] = await seed(page, baseURL, [hot]);
  await page.goto(leadPath(id));
  await expect(page).toHaveTitle("Page Hot");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page Hot");
  const values = ["Data leader at a software company", "Head of Data", "Blue Harbor Labs"];
  await expect(page.locator("main dl").first().locator("dd")).toHaveText(
    [...values, "Lisbon, Portugal"].flatMap((value) => [value, new RegExp(`^${FROM_IMPORT}$`)]),
  );
  // The name's, the four fields' and the LinkedIn URL's.
  await expect(page.locator("main small")).toHaveText(
    Array(6).fill(new RegExp(`^${FROM_IMPORT}$`)),
  );

  const decision = section(page, "contacts.lead.qualification");
  const labels = ["status", "fit", "tier", "confidence", "icp_version", "scored_at"];
  await expect(decision.locator("dt")).toHaveText(labels.map((key) => say(`contacts.lead.${key}`)));
  await expect(decision.locator("dd")).toHaveText([
    say("contacts.leads.status.qualified"),
    "82",
    say("ui.tier.hot"),
    say("contacts.leads.confidence.high"),
    "2",
    DATE,
  ]);
  await expect(section(page, "contacts.lead.why").getByRole("listitem")).toHaveText([
    "Misses a must, location: “Lisbon, Portugal”",
    "Title and function: “Head of Data”, 4 of 6 criteria met",
    "Not enough data on company size",
  ]);
  await expect(section(page, "contacts.lead.summary").locator("p")).toHaveText([
    say("contacts.lead.summary_label"),
    SUMMARY,
  ]);

  const verdicts = page.getByRole("table", { name: say("contacts.lead.verdicts") });
  await expect(verdicts).toBeHidden();
  await page.locator("summary", { hasText: say("contacts.lead.verdicts") }).press("Enter");
  await expect(verdicts).toBeVisible();
  const rows = verdicts.locator("tbody tr");
  await expect(rows).toHaveCount(6);
  for (const [index, { criterion, verdict, evidence, weight }] of VERDICTS.entries()) {
    await expect(rows.nth(index).locator("th, td")).toHaveText([
      say(`qualification.criterion.${criterion}`),
      say(`qualification.verdict.${verdict}`),
      evidence,
      String(weight),
    ]);
  }
  await expect(section(page, "contacts.lead.disqualifiers").locator("p")).toHaveText(
    say("contacts.lead.no_disqualifiers"),
  );

  const linkedin = page.getByRole("link", { name: say("contacts.lead.linkedin") });
  await expect(linkedin).toHaveAttribute("href", "https://linkedin.com/in/e2e-page-hot");
  await expect(linkedin).toHaveAttribute("target", "_blank");
  await expect(linkedin).toHaveAttribute("rel", "noopener noreferrer");
  // The fixture's paragraph, after signals' evidence panel, which evidence-panel.spec.ts proves.
  await expect(page.locator('[data-slot="evidence"] > p')).toHaveText(
    say("fixture.evidence.body").replace("{personId}", id),
  );

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});

test("a hard-filtered lead says which filter stopped it and the ICP's values; an ai_failed one, the reason", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [stopped, failing] = await seed(page, baseURL, [filtered, failed]);
  await page.goto(leadPath(stopped));
  const decision = section(page, "contacts.lead.qualification");
  // Never scored: no fit, tier, confidence or ICP version; the time it was decided, as the list's.
  await expect(decision.locator("dt")).toHaveText([
    say("contacts.lead.status"),
    say("contacts.lead.decided_at"),
  ]);
  await expect(decision.locator("dd")).toHaveText([
    say("contacts.leads.status.hard_filtered"),
    DATE,
  ]);
  // The section's own paragraphs: the `cost` slot inside it holds credits' cost line.
  await expect(decision.locator(":scope > p")).toHaveText(say("contacts.lead.hard_filtered"));
  await expect(section(page, "contacts.lead.why").getByRole("listitem")).toHaveText([
    "The title “Recruiter” is none of the ICP’s: Head of Data, VP Data",
  ]);
  // No snapshot: no summary, verdicts or disqualifiers.
  await expect(section(page, "contacts.lead.summary")).toHaveCount(0);
  await expect(page.locator("main details")).toHaveCount(0);

  await page.goto(leadPath(failing));
  await expect(decision.locator("dd")).toHaveText([say("contacts.leads.status.ai_failed"), DATE]);
  await expect(decision.locator(":scope > p")).toHaveText(
    "Assessment failed: the answer was cut short.",
  );
  await expect(section(page, "contacts.lead.why")).toHaveCount(0);
});

test("from the list, a lead's previous and next follow the list's filter and sort, by fit and by newest, by the keyboard, and lead back to it", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [high, middle, low] = await seed(page, baseURL, [hot, warm, cool, filtered, failed]);
  await page.goto(`/w/${WORKSPACE}/leads`);
  const byFit = "?status=qualified&sort=fit";
  // The qualified leads only: the filtered and failed ones, which have no fit, would come last.
  expect(await rowLinks(page)).toEqual([high, middle, low].map((id) => leadPath(id, byFit)));
  await page.locator("tbody tr a").nth(1).press("Enter");
  await page.waitForURL((url) => url.pathname === leadPath(middle));

  const around = page.getByRole("navigation", { name: say("contacts.lead.navigation") });
  const back = around.getByRole("link", { name: say("contacts.lead.back") });
  const previous = around.getByRole("link", { name: say("contacts.lead.previous") });
  const next = around.getByRole("link", { name: say("contacts.lead.next") });
  await expect(back).toHaveAttribute("href", `/w/${WORKSPACE}/leads${byFit}`);
  await expect(previous).toHaveAttribute("href", leadPath(high, byFit));
  await expect(next).toHaveAttribute("href", leadPath(low, byFit));
  await back.focus();
  await page.keyboard.press("Tab");
  await expect(previous).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(next).toBeFocused();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.pathname === leadPath(low));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page Cool");
  await expect(previous).toHaveAttribute("href", leadPath(middle, byFit));
  await expect(next).toHaveCount(0);

  await back.press("Enter");
  await page.waitForURL((url) => url.pathname === `/w/${WORKSPACE}/leads` && url.search === byFit);
  await page
    .getByRole("button", { name: say("contacts.leads.columns.qualified_at") })
    .press("Enter");
  const sorted = page.getByRole("columnheader", {
    name: say("contacts.leads.columns.qualified_at"),
  });
  await expect(sorted).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator("[aria-busy]")).toHaveCount(0);
  const byNewest = await rowLinks(page);
  expect(byNewest).toHaveLength(3);
  for (const href of byNewest) expect(href).toMatch(/\?status=qualified&sort=newest$/);
  await page.locator("tbody tr a").first().press("Enter");
  await page.waitForURL((url) => `${url.pathname}${url.search}` === byNewest[0]);
  await expect(previous).toHaveCount(0);
  await expect(next).toHaveAttribute("href", byNewest[1] ?? "");
});

test("another workspace's person, and a person whose lead is gone, are the lead page's not-found state, with the way back to the list", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [kept, gone] = await seed(page, baseURL, [hot, warm]);
  await seed(page, baseURL, [hot]);
  const heading = page.getByRole("heading", { level: 1 });
  await page.goto(leadPath(gone, "?status=qualified&sort=newest"));
  await expect(heading).toHaveText(say("contacts.lead.not_found"));
  await expect(page.getByText(say("contacts.errors.lead_not_found"))).toBeVisible();
  await expect(page.getByRole("link", { name: say("contacts.lead.back") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/leads?status=qualified&sort=newest`,
  );
  await page.goto(`/w/wsp_fixture_a/leads/${kept}`);
  await expect(heading).toHaveText(say("contacts.lead.not_found"));
  await page.goto(leadPath(kept));
  await expect(heading).toHaveText("Page Hot");
});
