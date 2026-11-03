// contacts' Approve and the outreach status (beta-p2-030; core/modules/contacts/README.md "Screens"),
// on leads that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in
// wsp_e2e_approve, where the e2e user has a connected LinkedIn account, and wsp_e2e_approve_none,
// where they have none (core/apps/api/tests/e2e-server.ts), both this spec's alone: Approve from the
// lead page's header and from the list's row menu, the header's badge and the list's Outreach
// column, the Outreach filter in the address, and Approve disabled with its hint without an
// account. Axe on both screens.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_approve";
const WITHOUT_ACCOUNT = "wsp_e2e_approve_none";
const messages: Record<string, string> = contacts;

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const lead = (slug: string, fitScore: number) => ({
  slug: `e2e-approve-${slug}`,
  firstName: "Ada",
  lastName: slug,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
  decision: { status: "qualified", fitScore, confidence: "high", tier: "hot" },
});

/** Replaces the workspace's leads with these, through the e2e api's test-only route; their ids. */
async function seed(page: Page, origin: string | undefined, workspace: string, leads: object[]) {
  const answer = await page.request.post(`/api/v1/workspaces/${workspace}/e2e/leads`, {
    data: { leads },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const status = (key: string) => say(`contacts.outreach_status.${key}`);
const rows = (page: Page) => page.locator("tbody tr");
/** The Outreach column's cells: the eighth after the name's row header. */
const outreachCells = (page: Page) => rows(page).locator("td:nth-of-type(8)");

test("Approve on the lead page's header and in the list's row menu: the badge, the column and the filter in the address follow; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [first] = await seed(page, baseURL, WORKSPACE, [lead("first", 90), lead("second", 80)]);

  await page.goto(`/w/${WORKSPACE}/leads/${first}`);
  const header = page.locator("header.wt-page-header");
  await expect(header.getByText(status("pending_review"), { exact: true })).toBeVisible();
  const approve = header.getByRole("button", { name: say("contacts.approve.action"), exact: true });
  await expect(approve).toBeEnabled();
  // A click before the page hydrates is lost: again until the badge answers.
  await expect(async () => {
    if (await approve.isVisible()) await approve.click();
    await expect(header.getByText(status("approved"), { exact: true })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass();
  const done = say("contacts.approve.done").replace("{name}", "Ada first");
  await expect(page.getByRole("status").filter({ hasText: done })).toBeVisible();
  await expect(
    header.getByRole("button", { name: say("contacts.approve.again"), exact: true }),
  ).toBeEnabled();
  await axe(page);

  await page.goto(`/w/${WORKSPACE}/leads`);
  await expect(
    page.getByRole("columnheader", { name: say("contacts.leads.columns.outreach") }),
  ).toBeVisible();
  await expect(outreachCells(page)).toHaveText([status("approved"), status("pending_review")]);
  const menu = page.getByRole("button", {
    name: say("contacts.leads.row_menu").replace("{name}", "Ada second"),
  });
  const item = page.getByRole("button", { name: say("contacts.approve.action"), exact: true });
  await expect(async () => {
    await menu.click();
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await item.click();
  await expect(outreachCells(page)).toHaveText([status("approved"), status("approved")]);
  await expect(page).toHaveURL((url) => url.pathname === `/w/${WORKSPACE}/leads`);
  await axe(page);

  const filter = page.getByLabel(say("contacts.leads.filter.outreach"), { exact: true });
  await filter.selectOption("pending_review");
  await expect(page).toHaveURL((url) => url.searchParams.get("outreach") === "pending_review");
  await expect(page.getByText(say("contacts.leads.empty.status"))).toBeVisible();
  await filter.selectOption("approved");
  await expect(page).toHaveURL((url) => url.searchParams.get("outreach") === "approved");
  await expect(rows(page)).toHaveCount(2);
  await page.reload();
  await expect(filter).toHaveValue("approved");
  await expect(outreachCells(page)).toHaveText([status("approved"), status("approved")]);
});

test("without a connected LinkedIn account of the user's own, the lead page's Approve is disabled with its hint; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [personId] = await seed(page, baseURL, WITHOUT_ACCOUNT, [lead("none", 75)]);

  await page.goto(`/w/${WITHOUT_ACCOUNT}/leads/${personId}`);
  const header = page.locator("header.wt-page-header");
  const approve = header.getByRole("button", { name: say("contacts.approve.action"), exact: true });
  await expect(approve).toBeDisabled();
  const words = say("contacts.approve.no_sender");
  await expect(approve).toHaveAccessibleDescription(words.replace(/<\/?link>/g, ""));
  const link = /<link>(.+)<\/link>/.exec(words)?.[1] ?? "";
  await expect(header.getByRole("link", { name: link, exact: true })).toHaveAttribute(
    "href",
    `/w/${WITHOUT_ACCOUNT}/linkedin`,
  );
  await expect(header.getByText(status("pending_review"), { exact: true })).toBeVisible();
  await axe(page);
});
