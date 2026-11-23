// The end-to-end test of DataTable and Dialog (alpha-p1-160), on the gallery page of gallery-page.ts:
// their entries and states, the table sorted, paged and followed by keyboard, its controlled mode
// (alpha-p6-050), the dialog's focus, and axe with the dialog open; the focus back on the opener
// however the dialog closes, the page held still, and Tab past hidden and disabled controls
// (gamma-p2-070).
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
  await expect(dialogs.getByRole("button")).toHaveText([
    say("ui.action.delete"),
    say("ui.gallery.edit_step"),
  ]);
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

test("Dialog returns the focus to its opener after Cancel and after its action", async ({
  page,
}) => {
  await openGallery(page, text);
  const opener = entry(page, "Dialog")
    .getByRole("button", { name: say("ui.action.delete") })
    .first();
  const dialog = page.getByRole("dialog", { name: say("ui.gallery.delete_title") });
  for (const button of [say("ui.action.cancel"), say("ui.action.delete")]) {
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: button }).click();
    await expect(dialog).toBeHidden();
    await expect(opener, `the focus after ${button}`).toBeFocused();
  }
});

test("Dialog unmounted while open returns the focus to its opener and lets the page scroll", async ({
  page,
}) => {
  await openGallery(page, text);
  // The second case is rendered only while open: Save and Cancel unmount it, open.
  const opener = entry(page, "Dialog").getByRole("button", { name: say("ui.gallery.edit_step") });
  const dialog = page.getByRole("dialog", { name: say("ui.gallery.edit_step") });
  const root = page.locator("html");
  for (const button of [say("ui.action.save"), say("ui.action.cancel")]) {
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(root).toHaveCSS("overflow", "hidden");
    await dialog.getByRole("button", { name: button }).click();
    // Unmounted, not closed: the first case's dialog is the one left in the page.
    await expect(page.locator("dialog")).toHaveCount(1);
    await expect(opener, `the focus after ${button}`).toBeFocused();
    await expect(root).toHaveCSS("overflow", "visible");
  }
});

test("Dialog holds the page behind still while open, then puts back the overflow it found", async ({
  page,
}) => {
  await openGallery(page, text);
  const root = page.locator("html");
  // A value of the host's own, which closing puts back.
  await root.evaluate((html) => {
    html.style.overflow = "auto";
  });
  const opener = entry(page, "Dialog")
    .getByRole("button", { name: say("ui.action.delete") })
    .first();
  const dialog = page.getByRole("dialog", { name: say("ui.gallery.delete_title") });
  const scrolled = () => page.evaluate(() => window.scrollY);
  const frames = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(root).toHaveCSS("overflow", "hidden");
  const before = await scrolled();
  await page.mouse.wheel(0, 400);
  await frames();
  expect(await scrolled()).toBe(before);
  await dialog.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(dialog).toBeHidden();
  await expect(root).toHaveCSS("overflow", "auto");
  await page.mouse.wheel(0, 400);
  await expect.poll(scrolled).not.toBe(before);
});

test("Dialog's Tab passes over its hidden and disabled controls, either way round", async ({
  page,
}) => {
  await openGallery(page, text);
  await entry(page, "Dialog")
    .getByRole("button", { name: say("ui.gallery.edit_step") })
    .click();
  const dialog = page.getByRole("dialog", { name: say("ui.gallery.edit_step") });
  const delay = dialog.getByRole("spinbutton", { name: say("ui.gallery.delay") });
  const button = (key: string) => dialog.getByRole("button", { name: say(key) });
  // The footer ends in a disabled Delete and a hidden Try again; the first control has the focus.
  await expect(button("ui.action.delete")).toBeDisabled();
  await expect(dialog.locator("button[hidden]")).toHaveCount(1);
  await expect(delay).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(button("ui.action.save")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(delay).toBeFocused();
  for (const key of ["ui.action.cancel", "ui.action.save"]) {
    await page.keyboard.press("Tab");
    await expect(button(key)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(delay).toBeFocused();
});

// axe (MPL-2.0, a test-only devDependency) on the whole gallery with the dialog open.
test("the gallery with the dialog open has no serious or critical axe violation", async ({
  page,
}) => {
  await openGallery(page, text);
  await entry(page, "Dialog").getByRole("button").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});
