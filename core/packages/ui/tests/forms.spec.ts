// The end-to-end test of the form components (alpha-p1-155) on the gallery page: each field in its
// states, TextArea's counter and limit, ChipInput by keyboard and its list of options (open on a
// focus and after a pick, closed by Escape, a long one scrolling), NumberField's keys, typing,
// bounds and error (gamma-p2-070), and axe with that list open and that error shown.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { IntlMessageFormat } from "intl-messageformat";
import { galleryMessages, openGallery } from "./gallery-page.ts";

// The gallery names its countries in the browser's language (Intl.DisplayNames).
test.use({ locale: "en-US" });

const text = galleryMessages();
const entry = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
// The gallery's countries in the options' order, as the browser names them in en-US.
const COUNTRIES = [
  "Austria",
  "Switzerland",
  "Germany",
  "Spain",
  "France",
  "United Kingdom",
  "Italy",
  "Netherlands",
  "United States",
];

/** The text of a key, formatted as the gallery formats it; a key missing there fails the test. */
function say(key: string, values?: Record<string, string | number>): string {
  const message = text[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return String(new IntlMessageFormat(message, "en").format(values));
}

const counter = (count: number) => say("ui.field.counter", { count, max: 1000 });

test("each form field renders its states: hint, error, disabled, counter, chips, placeholders", async ({
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
  // Each mode's placeholder says how to add a value: free text, or a list of options.
  await expect(inputs.first()).toHaveAttribute("placeholder", say("ui.field.placeholder_text"));
  await expect(countries).toHaveAttribute("placeholder", say("ui.field.placeholder_options"));
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

test("NumberField steps by its keys within its bounds, says its value with its unit, waits for typed text and shows the module's error", async ({
  page,
}) => {
  await openGallery(page, text);
  const fields = entry(page, "NumberField");
  const name = say("ui.gallery.delay");
  const delay = fields.getByRole("spinbutton", { name }).first();
  const [hint, unit] = [say("ui.gallery.hint"), say("ui.gallery.business_days")];
  const error = say("ui.gallery.whole_number", { min: 0, max: 30 });
  /** The value the gallery holds: in the box, as the spin button's value, and with its unit. */
  const holds = async (value: number) => {
    await expect(delay).toHaveValue(String(value));
    await expect(delay).toHaveAttribute("aria-valuenow", String(value));
    const words = say("ui.field.number_unit", { value, unit });
    await expect(delay).toHaveAttribute("aria-valuetext", words);
  };
  await expect(delay).toHaveAttribute("aria-valuemin", "0");
  await expect(delay).toHaveAttribute("aria-valuemax", "30");
  await expect(delay).toHaveAccessibleDescription(hint);
  await expect(fields.getByText(unit)).toBeVisible();
  await holds(3);
  // A step, ten steps and the bounds, never past 0 or 30.
  const keys = [
    ["ArrowUp", 4],
    ["ArrowDown", 3],
    ["PageUp", 13],
    ["PageUp", 23],
    ["PageUp", 30],
    ["ArrowUp", 30],
    ["PageDown", 20],
    ["Home", 0],
    ["ArrowDown", 0],
    ["PageDown", 0],
    ["End", 30],
  ] as const;
  await delay.focus();
  for (const [key, value] of keys) {
    await page.keyboard.press(key);
    await holds(value);
  }
  // Typed text stays as typed while the field has the focus; leaving it, or Enter, passes it on.
  await delay.fill("12");
  await expect(delay).toHaveValue("12");
  await expect(delay).toHaveAttribute("aria-valuenow", "30");
  await page.keyboard.press("Tab");
  await holds(12);
  await delay.fill("15");
  await page.keyboard.press("Enter");
  await holds(15);
  // A key steps from the number typed.
  await delay.fill("5");
  await page.keyboard.press("ArrowUp");
  await holds(6);
  // Text that is no whole number from 0 to 30 passes null: it stays, beside the gallery's error.
  for (const typed of ["abc", "4.5", "31", "-1"]) {
    await delay.fill(typed);
    await delay.blur();
    await expect(delay).toHaveValue(typed);
    await expect(delay).not.toHaveAttribute("aria-valuenow");
    await expect(delay).toHaveAttribute("aria-invalid", "true");
    await expect(delay).toHaveAccessibleDescription(`${hint} ${error}`);
  }
  await delay.fill("7");
  await delay.blur();
  await holds(7);
  await expect(delay).not.toHaveAttribute("aria-invalid");
  // The second field shows the module's error, with no value and no unit to say.
  const other = fields.getByRole("spinbutton", { name }).last();
  await expect(other).toHaveAttribute("aria-invalid", "true");
  await expect(other).toHaveAccessibleDescription(say("ui.gallery.error"));
  await expect(other).not.toHaveAttribute("aria-valuetext");
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

test("a ChipInput's list opens on a focus with every option not chosen, stays open after a pick, closes on Escape or on leaving", async ({
  page,
}) => {
  await openGallery(page, text);
  const chips = entry(page, "ChipInput");
  const name = say("ui.gallery.countries");
  const countries = chips.getByRole("combobox", { name });
  const options = chips.getByRole("listbox", { name }).getByRole("option");
  const active = chips.getByRole("option", { selected: true });
  const before = chips.getByRole("textbox", { name: say("ui.gallery.job_titles") }).first();
  // Tab from the field before it: the list is open at once, in the options' order, none active yet.
  await before.focus();
  await page.keyboard.press("Tab");
  await expect(countries).toBeFocused();
  await expect(countries).toHaveAttribute("aria-expanded", "true");
  await expect(options).toHaveText(COUNTRIES);
  await expect(active).toHaveCount(0);
  await expect(countries).not.toHaveAttribute("aria-activedescendant");
  // A pick, here by a click, keeps the focus and the list, without the picked country.
  await chips.getByRole("option", { name: "Germany", exact: true }).click();
  await expect(chips.getByRole("list", { name }).getByRole("listitem")).toHaveText(["Germany"]);
  await expect(countries).toBeFocused();
  await expect(options).toHaveText(COUNTRIES.filter((country) => country !== "Germany"));
  // Typing narrows it: the labels holding the text, those that start with it first, the first active.
  await page.keyboard.type("s");
  const narrowed = ["Switzerland", "Spain", "Austria", "Netherlands", "United States"];
  await expect(options).toHaveText(narrowed);
  await expect(active).toHaveText("Switzerland");
  // Escape closes it, and ArrowDown opens it again, the input pointing at its active option.
  await page.keyboard.press("Escape");
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await expect(options).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(countries).toHaveAttribute("aria-expanded", "true");
  await expect(active).toHaveText("Switzerland");
  const pointed = await countries.evaluate((input) => {
    const target = input.getAttribute("aria-activedescendant") ?? "";
    return document.getElementById(target)?.textContent;
  });
  expect(pointed).toBe("Switzerland");
  // ArrowUp opens it too, from its last option.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowUp");
  await expect(countries).toHaveAttribute("aria-expanded", "true");
  await expect(active).toHaveText("United States");
  // Leaving the field closes it; a click into it opens it, and so does a click once Escape closed it.
  await page.keyboard.press("Tab");
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await countries.click();
  await expect(countries).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await countries.click();
  await expect(countries).toHaveAttribute("aria-expanded", "true");
});

test("a ChipInput takes picks in a row until every option is chosen; then its list no longer opens", async ({
  page,
}) => {
  await openGallery(page, text);
  const chips = entry(page, "ChipInput");
  const name = say("ui.gallery.countries");
  const countries = chips.getByRole("combobox", { name });
  const options = chips.getByRole("listbox", { name }).getByRole("option");
  await countries.click();
  for (const country of COUNTRIES) {
    await expect(options.first()).toHaveText(country);
    await options.first().click();
  }
  await expect(chips.getByRole("list", { name }).getByRole("listitem")).toHaveText(COUNTRIES);
  await expect(countries).toBeFocused();
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  // Neither an arrow, a click nor a new focus opens it.
  await page.keyboard.press("ArrowDown");
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await countries.click();
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(countries).toBeFocused();
  await expect(countries).toHaveAttribute("aria-expanded", "false");
  await expect(options).toHaveCount(0);
});

test("a ChipInput's long list scrolls, and the arrows keep its active option in view", async ({
  page,
}) => {
  await openGallery(page, text);
  const chips = entry(page, "ChipInput");
  const name = say("ui.gallery.languages");
  const list = chips.getByRole("listbox", { name });
  const options = list.getByRole("option");
  const count = 20; // the gallery's languages
  await chips.getByRole("combobox", { name }).focus();
  // Every option is there, more than the list's height holds: it scrolls.
  await expect(options).toHaveCount(count);
  expect(await list.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true);
  for (let index = 0; index < count; index++) {
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(index)).toBeInViewport({ ratio: 1 });
  }
  // Past the last, ArrowDown comes back to the first, scrolled back into view.
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).toBeInViewport({ ratio: 1 });
  // Tab goes on to the next field: the list that scrolls is no stop of its own.
  await page.keyboard.press("Tab");
  await expect(list).toBeHidden();
  await expect(entry(page, "Checkbox").getByRole("checkbox").first()).toBeFocused();
});

// axe (MPL-2.0, a test-only devDependency) runs in one test per spec: each comes out with its import.
test("the gallery passes axe with a NumberField's error shown and a ChipInput's list of options open after a focus, a long one too", async ({
  page,
}) => {
  await openGallery(page, text);
  const delay = entry(page, "NumberField").getByRole("spinbutton").first();
  await delay.fill("abc");
  await delay.blur();
  await expect(delay).toHaveAttribute("aria-invalid", "true");
  for (const name of [say("ui.gallery.countries"), say("ui.gallery.languages")]) {
    await entry(page, "ChipInput").getByRole("combobox", { name }).focus();
    await expect(page.getByRole("listbox", { name })).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const found = blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
    expect(found, name).toEqual([]);
  }
});
