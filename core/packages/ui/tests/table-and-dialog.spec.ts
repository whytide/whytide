// The end-to-end test of DataTable and Dialog (alpha-p1-160), on the gallery page of gallery-page.ts:
// their entries and states, the table sorted, paged and followed by keyboard, its controlled mode
// (alpha-p6-050), the dialog's focus, and axe with the dialog open.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { IntlMessageFormat } from "intl-messageformat";
import { galleryMessages, openGallery } from "./gallery-page.ts";

const text = galleryMessages();
const entry = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** The text of a key in the gallery's messages, formatted with `values`; a missing key fails. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const message = text[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return String(new IntlMessageFormat(message, "en").format(values));
}
const leads = (...numbers: number[]) =>
  numbers.map((number) => say("ui.gallery.lead_name", { number }));

test("DataTable and Dialog have gallery entries that render their states", async ({ page }) => {
  await openGallery(page, text);
  const tables = entry(page, "DataTable");
  const caption = say("ui.table.sortable", { caption: say("ui.gallery.leads") });
  const table = tables.getByRole("table", { name: caption });
  const headers = table.getByRole("columnheader");
  await expect(headers).toHaveText([say("ui.gallery.column_name"), say("ui.gallery.column_tier")]);
  await expect(headers.last()).toHaveAttribute("aria-sort", "descending");
  await expect(table.getByRole("link")).toHaveText(leads(2, 11, 5, 8, 7));
  await expect(
    tables.getByRole("navigation", { name: say("ui.table.pages") }).first(),
  ).toContainText(say("ui.table.page", { page: 1, pages: 3 }));
  await expect(tables.getByText(say("ui.state.empty"))).toBeVisible();
  const dialogs = entry(page, "Dialog");
  await expect(dialogs.getByRole("button")).toHaveText(say("ui.action.delete"));
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("DataTable sorts by a column, pages, and opens a row link, by keyboard", async ({ page }) => {
  await openGallery(page, text);
  const table = entry(page, "DataTable");
  const grid = table.getByRole("table").first();
  const links = grid.getByRole("link");
  const name = grid.getByRole("columnheader").first();
  await name.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await expect(links).toHaveText(leads(1, 2, 3, 4, 5));
  await page.keyboard.press("Enter");
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await expect(links).toHaveText(leads(12, 11, 10, 9, 8));
  await page.keyboard.press("Enter");
  const next = table.getByRole("button", { name: say("ui.table.next") }).first();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(table.getByRole("status")).toHaveText(say("ui.table.page", { page: 2, pages: 3 }));
  await expect(links).toHaveText(leads(6, 7, 8, 9, 10));
  await page.keyboard.press("Enter");
  await expect(links).toHaveText(leads(11, 12));
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(next).toBeFocused();
  await grid.getByRole("columnheader").last().getByRole("button").focus();
  await page.keyboard.press("Tab");
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(links.last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#lead-12$/);
});

test("DataTable in the controlled mode asks its module to sort and to page, with no page count", async ({
  page,
}) => {
  await openGallery(page, text);
  const caption = say("ui.table.sortable", { caption: say("ui.gallery.server_leads") });
  const table = entry(page, "DataTable").getByRole("table", { name: caption });
  const pager = entry(page, "DataTable").getByRole("navigation").last();
  const name = table.getByRole("columnheader").first();
  const tier = table.getByRole("columnheader").last();
  await expect(name).toHaveAttribute("aria-sort", "descending");
  await expect(table.getByRole("link")).toHaveText(leads(12, 11, 10, 9, 8));
  await expect(tier.getByRole("button")).toHaveCount(0);
  await name.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(name).toHaveAttribute("aria-sort", "ascending");
  await expect(table.getByRole("link")).toHaveText(leads(1, 2, 3, 4, 5));
  const previous = pager.getByRole("button", { name: say("ui.table.previous") });
  const next = pager.getByRole("button", { name: say("ui.table.next") });
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await next.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(table.getByRole("link")).toHaveText(leads(11, 12));
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await expect(pager.getByRole("status")).toHaveCount(0);
  await previous.click();
  await expect(table.getByRole("link")).toHaveText(leads(6, 7, 8, 9, 10));
});

test("Dialog keeps the focus inside, closes on Escape and returns the focus", async ({ page }) => {
  await openGallery(page, text);
  // The opener comes before the dialog, whose confirmation has the same word.
  const opener = entry(page, "Dialog")
    .getByRole("button", { name: say("ui.action.delete") })
    .first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: say("ui.gallery.delete_title") });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: say("ui.action.cancel") })).toBeFocused();
  const focusInside = () => dialog.evaluate((element) => element.contains(document.activeElement));
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(await focusInside(), `the focus after ${key}`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

// axe (MPL-2.0, a test-only devDependency) on the whole gallery with the dialog open.
test("the gallery with the dialog open has no serious or critical axe violation", async ({
  page,
}) => {
  await openGallery(page, text);
  await entry(page, "Dialog").getByRole("button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});
