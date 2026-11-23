// contacts' Edit on the lead page (lead-fields-edit; core/modules/contacts/README.md "Screens") on a
// lead that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e), in
// wsp_e2e_lead_edit, this spec's alone: Edit opens the dialog with the person's six fields; the
// title and the location changed and saved, the header shows them with its Edited mark, without a
// reload, and the profile card marks those two fields Edited, the others keeping their source; axe
// with the dialog open and after; the dialog and the page at a phone's width, a light screenshot.
// The seed keeps persons, and a member's value outlives an import, so each run seeds a new person.
import { randomBytes } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_lead_edit";
const messages: Record<string, string> = { ...contacts, ...ui };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** contacts.lead.provenance of an imported field and contacts.lead_edit.edited, medium dates. */
const FROM_IMPORT = /^From an import, \w{3} \d{1,2}, \d{4}$/;
const EDITED = /^Edited, \w{3} \d{1,2}, \d{4}$/;

/** A new person each run, from an import, and its lead; its id. */
async function seed(page: Page, origin: string | undefined) {
  const lead = {
    slug: `e2e-edit-${randomBytes(4).toString("hex")}`,
    firstName: "Page",
    lastName: "Edit",
    headline: "Data leader at a software company",
    title: "Head of Data",
    companyName: "Blue Harbor Labs",
    locationText: "Lisbon, Portugal",
    source: "imported",
    decision: { status: "qualified", fitScore: 82, confidence: "high", tier: "hot" },
  };
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [lead] },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const [id] = ((await answer.json()) as { personIds: string[] }).personIds;
  return id ?? "";
}

/** Serious and critical axe findings on the page as it stands. */
async function blocking(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
}

const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: say("contacts.lead_edit.title") });

test("Edit: the title and the location changed and saved show in the header with its Edited mark, without a reload, and the profile card marks the two; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const id = await seed(page, baseURL);
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  const header = page.locator(".wt-page-header");
  await expect(header.getByRole("heading", { level: 1 })).toHaveText("Page Edit");
  await expect(header.locator("small")).toHaveText(FROM_IMPORT);
  // A reload would lose this.
  await page.evaluate(() => Object.assign(window, { lead_edit_mark: true }));

  const edit = { name: say("contacts.lead_edit.action"), exact: true };
  await header.getByRole("button", edit).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  const labels = [
    say("contacts.lead_edit.first_name"),
    say("contacts.lead_edit.last_name"),
    say("contacts.lead.headline"),
    say("contacts.lead.job_title"),
    say("contacts.lead.company"),
    say("contacts.lead.location"),
  ];
  const values = ["Page", "Edit", "Data leader at a software company", "Head of Data"];
  for (const [index, value] of [...values, "Blue Harbor Labs", "Lisbon, Portugal"].entries())
    await expect(dialog.getByLabel(labels[index] ?? "", { exact: true })).toHaveValue(value);
  expect(await blocking(page)).toEqual([]);

  await dialog.getByLabel(say("contacts.lead.job_title"), { exact: true }).fill("VP Data");
  await dialog.getByLabel(say("contacts.lead.location"), { exact: true }).fill("Berlin, Germany");
  await dialog.getByRole("button", { name: say("ui.action.save") }).click();
  await expect(dialog).toBeHidden();

  await expect(header.getByText("VP Data at Blue Harbor Labs")).toBeVisible();
  await expect(header).toContainText("Berlin, Germany");
  await expect(header.locator("small")).toHaveText(EDITED);
  const saved = page.getByRole("status").filter({ hasText: say("contacts.lead_edit.saved") });
  await expect(saved).toBeVisible();
  // The profile card: each value, then its source, the two edited marked Edited.
  await expect(page.locator("main dl").first().locator("dd")).toHaveText([
    "Data leader at a software company",
    FROM_IMPORT,
    "VP Data",
    EDITED,
    "Blue Harbor Labs",
    FROM_IMPORT,
    "Berlin, Germany",
    EDITED,
  ]);
  expect(await page.evaluate(() => "lead_edit_mark" in window)).toBe(true);
  expect(await blocking(page)).toEqual([]);
});

test("at a phone's width the dialog and the page fit, nothing wider than the phone", async ({
  page,
  signInAs,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs();
  const id = await seed(page, baseURL);
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  await page.getByRole("button", { name: say("contacts.lead_edit.action"), exact: true }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  const wide = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth ? [`document ${root.scrollWidth}`] : [];
  });
  expect(wide).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("lead-edit-phone.png") });
});
