// The end-to-end test of the form components (alpha-p1-155) on the gallery page: each field in its
// states, TextArea's counter and limit, ChipInput by keyboard, and axe with a list of options open.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { IntlMessageFormat } from "intl-messageformat";
import { galleryMessages, openGallery } from "./gallery-page.ts";

// The gallery names its countries in the browser's language (Intl.DisplayNames).
test.use({ locale: "en-US" });

const text = galleryMessages();
const entry = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** The text of a key, formatted as the gallery formats it; a key missing there fails the test. */
function say(key: string, values?: Record<string, string | number>): string {
  const message = text[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return String(new IntlMessageFormat(message, "en").format(values));
}

const counter = (count: number) => say("ui.field.counter", { count, max: 1000 });

test("each form field renders its states: hint, error, disabled, counter, chips", async ({
  page,
}) => {
  await openGallery(page, text);
  const [hint, error] = [say("ui.gallery.hint"), say("ui.gallery.error")];
  // Each entry shows a field with the hint, one with the error, one disabled.
  const labels = { TextField: "company", TextArea: "notes", Select: "role", Checkbox: "notify" };
  for (const [name, label] of Object.entries(labels)) {
    const fields = entry(page, name).getByLabel(say(`ui.gallery.${label}`), { exact: true });
    await expect(fields).toHaveCount(3);
    const described = name === "TextArea" ? `${hint} ${counter(0)}` : hint;
    await expect(fields.first()).toHaveAccessibleDescription(described);
    await expect(fields.nth(1)).toHaveAttribute("aria-invalid", "true");
    await expect(fields.nth(1)).toHaveAccessibleDescription(error);
    await expect(fields.last()).toBeDisabled();
  }
  const boxes = entry(page, "Checkbox").getByRole("checkbox", { name: say("ui.gallery.notify") });
  await expect(boxes.last()).toBeChecked();
  await boxes.first().focus();
  await page.keyboard.press("Space");
  await expect(boxes.first()).toBeChecked();
  const notes = say("ui.gallery.sample_notes");
  await expect(entry(page, "TextArea").getByText(counter(notes.length))).toBeVisible();
  const roles = ["owner", "admin", "member"].map((role) => say(`ui.role.${role}`));
  await expect(entry(page, "Select").getByRole("combobox").first().locator("option")).toHaveText(
    roles,
  );

  const chips = entry(page, "ChipInput");
  const [titles, sample] = [say("ui.gallery.job_titles"), say("ui.gallery.sample_title")];
  const lists = chips.getByRole("list", { name: titles });
  await expect(lists.getByRole("listitem")).toHaveText([sample, sample]);
  const remove = say("ui.field.remove", { item: sample });
  await expect(lists.first().getByRole("button")).toHaveAccessibleName(remove);
  await expect(lists.last().getByRole("button")).toBeDisabled();
  const inputs = chips.getByRole("textbox", { name: titles });
  await expect(inputs.first()).toHaveAccessibleDescription(hint);
  await expect(inputs.last()).toBeDisabled();
  const countries = chips.getByRole("combobox", { name: say("ui.gallery.countries") });
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await expect(countries).toHaveAttribute("aria-invalid", "true");
  await expect(countries).toHaveAccessibleDescription(error);
});

test("TextArea with maxLength 1000 shows a counter and refuses the 1,001st character", async ({
  page,
}) => {
  await openGallery(page, text);
  const area = entry(page, "TextArea");
  const notes = area.getByLabel(say("ui.gallery.notes"), { exact: true }).first();
  const shown = area.locator(".wt-field__counter").first();
  await expect(shown).toHaveText(counter(0));
  await notes.fill("a".repeat(1000));
  await expect(shown).toHaveText(counter(1000));
  await notes.press("b");
  await expect(notes).toHaveValue("a".repeat(1000));
  // Pasted at once, 1,001 characters keep 1,000.
  await notes.fill("c".repeat(1001));
  await expect(notes).toHaveValue("c".repeat(1000));
  await expect(shown).toHaveText(counter(1000));
});

test("ChipInput adds and removes chips by keyboard and picks countries from its list", async ({
  page,
}) => {
  await openGallery(page, text);
  const chips = entry(page, "ChipInput");
  const titles = say("ui.gallery.job_titles");
  const input = chips.getByRole("textbox", { name: titles }).first();
  const list = chips.getByRole("list", { name: titles }).first();
  await input.focus();
  await page.keyboard.type("CTO");
  await page.keyboard.press("Enter");
  await expect(list.getByRole("listitem")).toHaveText([say("ui.gallery.sample_title"), "CTO"]);
  await expect(input).toHaveValue("");
  await page.keyboard.press("Shift+Tab");
  await expect(
    list.getByRole("button", { name: say("ui.field.remove", { item: "CTO" }) }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list.getByRole("listitem")).toHaveText([say("ui.gallery.sample_title")]);
  await expect(input).toBeFocused();

  const countries = chips.getByRole("combobox", { name: say("ui.gallery.countries") });
  await countries.focus();
  await page.keyboard.type("ger");
  await expect(countries).toHaveAttribute("aria-expanded", "true");
  await expect(chips.getByRole("option", { selected: true })).toHaveText("Germany");
  await page.keyboard.press("Enter");
  await page.keyboard.type("united");
  await expect(chips.getByRole("option")).toHaveText(["United Kingdom", "United States"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const chosen = chips.getByRole("list", { name: say("ui.gallery.countries") });
  await expect(chosen.getByRole("listitem")).toHaveText(["Germany", "United States"]);
  // A form posts the codes, as a multiple select would.
  const posted = chips.locator('input[type="hidden"][name="countries"]');
  await expect(posted).toHaveCount(2);
  await expect(posted.first()).toHaveValue("DE");
  await expect(posted.last()).toHaveValue("US");
});

// axe (MPL-2.0, a test-only devDependency) runs in one test per spec: each comes out with its import.
test("the gallery passes axe with a ChipInput's list of options open", async ({ page }) => {
  await openGallery(page, text);
  await entry(page, "ChipInput").getByRole("combobox").fill("a");
  await expect(page.getByRole("listbox")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});
