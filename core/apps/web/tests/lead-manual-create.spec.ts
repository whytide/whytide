// contacts' Add lead on the Leads screen (lead-manual-create; core/modules/contacts/README.md
// "Screens") on the e2e api, in wsp_e2e_lead_add, this spec's alone: Add lead in the header opens
// the dialog; a URL without its scheme, the names and the title added, the browser is on the lead's
// page, pending, and the list names its source Added manually; the same URL again shows lead_exists
// under the URL with a link to that lead; a URL that is no profile shows its words under the URL, a
// first name left out under the first name; axe with the dialog open and after; the empty state's
// Add lead and the dialog at a phone's width, a light screenshot. The e2e api's seed empties the
// workspace's leads and keeps its persons, so each run adds new persons.
import { randomBytes } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_lead_add";
const messages: Record<string, string> = { ...contacts, ...ui };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** A profile slug no run used before. */
const newSlug = () => `e2e-add-${randomBytes(4).toString("hex")}`;

/** The workspace's leads emptied (the e2e api's seed with none); its persons stay. */
async function reset(page: Page, origin: string | undefined) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [] },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

/** Serious and critical axe findings on the page as it stands. */
async function blocking(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
}

const ADD_LEAD = { name: say("contacts.lead_add.action"), exact: true };
const dialogOf = (page: Page) => page.getByRole("dialog", { name: say("contacts.lead_add.title") });
const fieldOf = (dialog: Locator, key: string) => dialog.getByLabel(say(key), { exact: true });

/** Add lead from the page header, the dialog filled with these values by their labels' keys. */
async function addFromHeader(page: Page, values: Record<string, string>) {
  await page.locator(".wt-page-header").getByRole("button", ADD_LEAD).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  for (const [key, value] of Object.entries(values)) await fieldOf(dialog, key).fill(value);
  await dialog.getByRole("button", { name: say("contacts.lead_add.add"), exact: true }).click();
  return dialog;
}

test("Add lead from the header: a URL without its scheme, the names and the title; the browser is on the lead's page, which shows the person, pending, and the list names the source Added manually; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await reset(page, baseURL);
  const slug = newSlug();
  await page.goto(`/w/${WORKSPACE}/leads`);
  await page.locator(".wt-page-header").getByRole("button", ADD_LEAD).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(say("contacts.lead_add.linkedin_url_hint"));
  expect(await blocking(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await addFromHeader(page, {
    "contacts.lead_add.linkedin_url": `linkedin.com/in/${slug}/`,
    "contacts.lead_edit.first_name": "Ada",
    "contacts.lead_edit.last_name": "Hand",
    "contacts.lead.job_title": "Head of Data",
  });
  await page.waitForURL(new RegExp(`/w/${WORKSPACE}/leads/per_\\w+$`));
  const header = page.locator(".wt-page-header");
  await expect(header.getByRole("heading", { level: 1 })).toHaveText("Ada Hand");
  await expect(header).toContainText("Head of Data");
  await expect(
    header.getByText(say("contacts.leads.status.pending"), { exact: true }),
  ).toBeVisible();
  expect(await blocking(page)).toEqual([]);

  await page.goto(`/w/${WORKSPACE}/leads?status=pending`);
  const row = page.getByRole("row").filter({ hasText: "Ada Hand" });
  await expect(row).toContainText(say("contacts.leads.source.manual"));
  expect(await blocking(page)).toEqual([]);
});

test("the same URL again shows lead_exists under the URL, the dialog open, with a link to that lead's page", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const slug = newSlug();
  const first = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/contacts/leads`, {
    data: { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Bo" },
    headers: { origin: baseURL ?? "" },
  });
  expect(first.status(), await first.text()).toBe(201);
  const { personId } = (await first.json()) as { personId: string };

  await page.goto(`/w/${WORKSPACE}/leads`);
  const dialog = await addFromHeader(page, {
    "contacts.lead_add.linkedin_url": `https://www.linkedin.com/in/${slug.toUpperCase()}`,
    "contacts.lead_edit.first_name": "Bo",
  });
  const url = fieldOf(dialog, "contacts.lead_add.linkedin_url");
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(url).toHaveAccessibleDescription(new RegExp(say("contacts.errors.lead_exists")));
  const open = dialog.getByRole("link", { name: say("contacts.lead_add.open_existing") });
  await expect(open).toHaveAttribute("href", `/w/${WORKSPACE}/leads/${personId}`);
  expect(await blocking(page)).toEqual([]);
  await open.click();
  await page.waitForURL(new RegExp(`/w/${WORKSPACE}/leads/${personId}$`));
  await expect(page.locator(".wt-page-header").getByRole("heading", { level: 1 })).toHaveText("Bo");
});

test("a URL that is no profile shows its words under the URL, and a first name left out under the first name; the dialog stays open", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/leads`);
  const dialog = await addFromHeader(page, {
    "contacts.lead_add.linkedin_url": "https://example.com/in/someone",
    "contacts.lead_edit.first_name": "Cy",
  });
  const url = fieldOf(dialog, "contacts.lead_add.linkedin_url");
  await expect(url).toHaveAccessibleDescription(
    new RegExp(say("contacts.errors.linkedin_url_invalid")),
  );
  await expect(url).toHaveAttribute("aria-invalid", "true");

  await url.fill(`linkedin.com/in/${newSlug()}`);
  await fieldOf(dialog, "contacts.lead_edit.first_name").fill("");
  await dialog.getByRole("button", { name: say("contacts.lead_add.add"), exact: true }).click();
  const first = fieldOf(dialog, "contacts.lead_edit.first_name");
  await expect(first).toHaveAccessibleDescription(say("contacts.errors.contacts_input_invalid"));
  await expect(url).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog).toBeVisible();
  expect(await blocking(page)).toEqual([]);
});

test("with no lead, the empty state offers Add lead beside Sources and Import a CSV; at a phone's width its dialog fits, nothing wider than the phone", async ({
  page,
  signInAs,
  baseURL,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs();
  await reset(page, baseURL);
  await page.goto(`/w/${WORKSPACE}/leads`);
  const empty = page.locator(".wt-empty-state");
  await expect(empty).toContainText(say("contacts.leads.empty.none"));
  await expect(
    empty.getByRole("link", { name: say("contacts.leads.links.sources") }),
  ).toBeVisible();
  await expect(empty.getByRole("link", { name: say("contacts.leads.links.import") })).toBeVisible();
  await empty.getByRole("button", ADD_LEAD).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  // Not the empty state's centred text.
  expect(await dialog.evaluate((node) => getComputedStyle(node).textAlign)).toBe("start");
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  const wide = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth > root.clientWidth ? [`document ${root.scrollWidth}`] : [];
  });
  expect(wide).toEqual([]);
  expect(await blocking(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("lead-add-phone.png") });
});
