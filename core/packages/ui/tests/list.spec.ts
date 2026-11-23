// The end-to-end test of ReorderableList (gamma-p2-070) on the gallery page of gallery-page.ts: steps
// moved up and down by keyboard, the focus left on the moved step's button, the live region's words,
// the end buttons disabled, Remove called back with the step's index, and axe after a move.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { IntlMessageFormat } from "intl-messageformat";
import { galleryMessages, openGallery } from "./gallery-page.ts";

const text = galleryMessages();
const entry = (page: Page, name = "ReorderableList") =>
  page.getByRole("region", { name, exact: true });

/** The text of a key in the gallery's messages, formatted with `values`; a missing key fails. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const message = text[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return String(new IntlMessageFormat(message, "en").format(values));
}
const step = (number: number) => say("ui.gallery.step_name", { number });
/** The steps in this order, each row starting with its name. */
const order = (...numbers: number[]) => numbers.map((number) => new RegExp(`^${step(number)}`));
/** The words the live region says after a move. */
const moved = (number: number, position: number) =>
  say("ui.list.moved", { item: step(number), position, count: 3 });

/** A step's button, named by the kit's word with the step's name. */
function button(page: Page, word: "move_up" | "move_down" | "remove", number: number) {
  const name = say(`ui.list.${word}`, { item: step(number) });
  return entry(page).getByRole("button", { name, exact: true });
}

test("ReorderableList moves a step up and down by keyboard, the focus on its button, and says where it went", async ({
  page,
}) => {
  await openGallery(page, text);
  const steps = entry(page).getByRole("listitem");
  const status = entry(page).getByRole("status");
  await expect(steps).toHaveText(order(1, 2, 3));
  await expect(status).toBeEmpty();
  // The ends: the first step does not move up, the last does not move down.
  await expect(button(page, "move_up", 1)).toBeDisabled();
  await expect(button(page, "move_down", 3)).toBeDisabled();
  await expect(button(page, "move_down", 1)).toBeEnabled();
  // Step 2 up, by Enter: first now, the focus still on its Move up, disabled at the top.
  await button(page, "move_up", 2).focus();
  await page.keyboard.press("Enter");
  await expect(steps).toHaveText(order(2, 1, 3));
  await expect(button(page, "move_up", 2)).toBeFocused();
  await expect(button(page, "move_up", 2)).toBeDisabled();
  await expect(status).toHaveText(moved(2, 1));
  // A disabled end button does nothing.
  await page.keyboard.press("Enter");
  await expect(steps).toHaveText(order(2, 1, 3));
  // Step 2 down twice, by Space: last now, the focus still on its Move down.
  await button(page, "move_down", 2).focus();
  await page.keyboard.press("Space");
  await expect(steps).toHaveText(order(1, 2, 3));
  await expect(button(page, "move_down", 2)).toBeFocused();
  await expect(status).toHaveText(moved(2, 2));
  await page.keyboard.press("Space");
  await expect(steps).toHaveText(order(1, 3, 2));
  await expect(button(page, "move_down", 2)).toBeFocused();
  await expect(button(page, "move_down", 2)).toBeDisabled();
  await expect(status).toHaveText(moved(2, 3));
});

test("ReorderableList's Remove calls back with the step's index, the focus on the Remove now in its place", async ({
  page,
}) => {
  await openGallery(page, text);
  const steps = entry(page).getByRole("listitem");
  await button(page, "remove", 2).focus();
  await page.keyboard.press("Enter");
  await expect(steps).toHaveText(order(1, 3));
  await expect(button(page, "remove", 3)).toBeFocused();
  // The last one removed, the focus goes to the Remove before it.
  await page.keyboard.press("Enter");
  await expect(steps).toHaveText(order(1));
  await expect(button(page, "remove", 1)).toBeFocused();
});

// axe (MPL-2.0, a test-only devDependency) runs in one test per spec: each comes out with its import.
test("ReorderableList passes axe after a move, in either theme", async ({ page }) => {
  await openGallery(page, text);
  await button(page, "move_down", 1).click();
  await expect(entry(page).getByRole("status")).toHaveText(moved(1, 2));
  for (const theme of ["light", "dark"] as const) {
    await entry(page, "ThemeToggle")
      .getByText(say(`ui.theme.${theme}`), { exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const list = '[aria-labelledby="gallery-ReorderableList"]';
    const { violations } = await new AxeBuilder({ page }).include(list).analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const found = blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
    expect(found, `the ${theme} theme`).toEqual([]);
  }
});
