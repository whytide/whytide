// A member's verdict on contacts' lead page (lead-verdict-edit; core/modules/contacts/README.md
// "Screens", core/modules/qualification/README.md "A member's verdict"), in wsp_e2e_verdicts, this
// spec's alone, on a needs_review lead that the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e), its location, a must, unknown: Edit sets it to Met with a note
// through qualification's route, and the row, the status and the why show the new decision without
// a reload; "Use the model's verdict" clears it; axe on the page and the dialog; the page and the
// dialog fit a phone's width, with a light screenshot.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_verdicts";
const messages: Record<string, string> = { ...contacts, ...qualification, ...ui };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** fit-v1 of the default criteria: (300 + 150 + 100 + 150 + 40 + 200) / 100 is 94, location unknown. */
const VERDICTS = [
  { criterion: "title_function", verdict: "met", evidence: "Head of Data", weight: 30, points: 1 },
  { criterion: "seniority", verdict: "met", evidence: "Head of Data", weight: 15, points: 1 },
  { criterion: "company_size", verdict: "met", evidence: "51-200", weight: 10, points: 1 },
  { criterion: "industry", verdict: "met", evidence: "Software", weight: 15, points: 1 },
  { criterion: "location", verdict: "unknown", evidence: "", weight: 10, points: 0.4 },
  { criterion: "must_haves", verdict: "met", evidence: "Runs a data team", weight: 20, points: 1 },
];
const REVIEW = {
  status: "needs_review",
  fitScore: 94,
  confidence: "high",
  tier: "hot",
  icpVersion: 2,
};
const LEAD = {
  slug: "e2e-verdicts-review",
  firstName: "Verdict",
  lastName: "Review",
  title: "Head of Data",
  source: "imported",
  decision: {
    ...REVIEW,
    why: [{ key: "qualification.why.gap", params: { criterion: "location", more: 0 } }],
  },
  snapshot: { ...REVIEW, summary: "A data leader.", disqualifiers: [], verdicts: VERDICTS },
};

/** The lead, written again by the e2e api's test-only route; its person's id. */
async function seed(page: Page, origin: string | undefined): Promise<string> {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [LEAD] },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const [personId] = ((await answer.json()) as { personIds: string[] }).personIds;
  return personId ?? "";
}

const section = (page: Page, key: string) => page.getByRole("region", { name: say(key) });
const status = (page: Page) => section(page, "contacts.lead.qualification").locator("dd").first();
const verdicts = (page: Page) => page.getByRole("table", { name: say("contacts.lead.verdicts") });
const locationRow = (page: Page) =>
  verdicts(page)
    .locator("tbody tr")
    .filter({ hasText: say("qualification.criterion.location") });

/** The lead page, its verdicts opened. */
async function open(page: Page, personId: string) {
  await page.goto(`/w/${WORKSPACE}/leads/${personId}`);
  await page.locator("summary", { hasText: say("contacts.lead.verdicts") }).click();
  await expect(verdicts(page)).toBeVisible();
}

/** The blocking findings of axe on the page as it is. */
async function blocking(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
}

test("a member sets an unknown verdict: the row, the status and the why change without a reload; Use the model's verdict clears it; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const personId = await seed(page, baseURL);
  await open(page, personId);
  await expect(status(page)).toHaveText(say("contacts.leads.status.needs_review"));
  await expect(page.getByText("Needs review: Location is unknown.")).toBeVisible();
  await expect(section(page, "contacts.lead.why").getByRole("listitem")).toHaveText([
    "Not enough data on location",
  ]);
  // A reload would lose this.
  await page.evaluate(() => Object.assign(window, { stayed: true }));

  await locationRow(page).getByRole("button", { name: "Edit the verdict on Location" }).click();
  const dialog = page.getByRole("dialog", { name: "Your verdict on Location" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("The model’s verdict: Unknown")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: say("contacts.lead.verdict_use_model") }),
  ).toHaveCount(0);
  expect(await blocking(page)).toEqual([]);
  await dialog.getByLabel(say("contacts.lead.verdict")).selectOption("met");
  await dialog.getByLabel(say("contacts.lead.verdict_note")).fill("Works from the Lisbon office.");
  await dialog.getByRole("button", { name: say("ui.action.save") }).click();
  await expect(dialog).toBeHidden();

  // The last unknown set: the lead leaves needs_review, in place.
  await expect(status(page)).toHaveText(say("contacts.leads.status.qualified"));
  await expect(page.getByText("Needs review: Location is unknown.")).toHaveCount(0);
  const cells = locationRow(page).locator("td");
  await expect(cells.first()).toContainText(say("qualification.verdict.met"));
  await expect(cells.first()).toContainText(/Set by you, \w{3} \d{1,2}, \d{4}/);
  await expect(cells.first()).toContainText("Works from the Lisbon office.");
  await expect(cells.first()).toContainText("The model’s verdict: Unknown");
  const why = section(page, "contacts.lead.why").getByRole("listitem");
  await expect(why).toHaveText(["Title and function: “Head of Data”, 6 of 6 criteria met"]);
  expect(await page.evaluate(() => (window as { stayed?: boolean }).stayed)).toBe(true);
  expect(await blocking(page)).toEqual([]);

  // Back to the model's verdict: needs_review again.
  await locationRow(page).getByRole("button", { name: "Edit the verdict on Location" }).click();
  await expect(dialog.getByLabel(say("contacts.lead.verdict"))).toHaveValue("met");
  await dialog.getByRole("button", { name: say("contacts.lead.verdict_use_model") }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText(say("contacts.leads.status.needs_review"));
  await expect(locationRow(page).locator("td").first()).toHaveText(
    say("qualification.verdict.unknown"),
  );
  await expect(page.getByText("Needs review: Location is unknown.")).toBeVisible();
  await expect(why).toHaveText([
    "Title and function: “Head of Data”, 5 of 6 criteria met",
    "Not enough data on location",
  ]);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the lead page with its verdicts and the verdict dialog fit; a light screenshot", async ({
    page,
    signInAs,
    baseURL,
  }, testInfo) => {
    await signInAs();
    const personId = await seed(page, baseURL);
    await page.emulateMedia({ colorScheme: "light" });
    await open(page, personId);
    /** What is wider than the phone: the document, main or an ancestor of main. */
    const overflows = () =>
      page.evaluate(() => {
        const wide: string[] = [];
        const root = document.documentElement;
        if (root.scrollWidth > root.clientWidth) wide.push(`document ${root.scrollWidth}`);
        for (let box = document.querySelector("main"); box; box = box.parentElement) {
          if (box.scrollWidth > box.clientWidth) wide.push(`${box.tagName} ${box.scrollWidth}`);
        }
        const dialog = document.querySelector("dialog[open]");
        if (dialog && dialog.getBoundingClientRect().right > root.clientWidth) wide.push("dialog");
        return wide;
      });
    expect(await overflows()).toEqual([]);
    await locationRow(page).getByRole("button", { name: "Edit the verdict on Location" }).click();
    await expect(page.getByRole("dialog", { name: "Your verdict on Location" })).toBeVisible();
    expect(await overflows()).toEqual([]);
    // Kept under test-results/ for a look: light only (the owner's rule for screens).
    const path = testInfo.outputPath("verdict-dialog-phone-light.png");
    await page.screenshot({ path });
    await testInfo.attach("verdict-dialog-phone-light", { path, contentType: "image/png" });
  });
});
