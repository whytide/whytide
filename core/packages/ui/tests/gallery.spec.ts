// The end-to-end test of @whytide/ui (alpha-p1-150): the gallery, bundled by esbuild and loaded into
// Playwright's Chromium without Next.js, shows every component in its states with the text of its
// message keys, translates an error code, copies by keyboard, and passes axe.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { galleryMessages, keysOnly, openGallery } from "./gallery-page.ts";

const COMPONENTS = [
  "PageHeader Button Link Badge Tooltip EmptyState ErrorState LoadingState Toast CopyButton",
  "DataTable Dialog",
  "TextField TextArea Select ChipInput Checkbox Switch SaveBar",
  "Card StatCard Meter Skeleton Avatar Kbd Menu ThemeToggle Logo",
].flatMap((line) => line.split(" "));
const text = galleryMessages();
const entry = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

/** The text of a key in the gallery's messages; a key missing there fails the test. */
function say(key: string): string {
  const value = text[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

test("every component has an entry and renders its states", async ({ page }) => {
  await openGallery(page, text);
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(COMPONENTS);
  const header = entry(page, "PageHeader");
  const title = say("ui.gallery.title");
  await expect(header.getByRole("heading", { level: 1 })).toHaveText([
    title,
    title,
    say("ui.gallery.sample_company"),
  ]);
  await expect(header.getByRole("button")).toHaveText(say("ui.action.save"));
  const buttons = entry(page, "Button").getByRole("button");
  const labels = ["save", "cancel", "delete", "copy", "save"].map((key) => say(`ui.action.${key}`));
  await expect(buttons).toHaveText([...labels, say("ui.gallery.pressed")]);
  await expect(buttons.nth(4)).toHaveAttribute("aria-busy", "true");
  await expect(buttons.last()).toHaveAttribute("aria-pressed", "true");
  await expect(entry(page, "Link").getByRole("link")).toHaveText(say("ui.action.cancel"));
  const tones = ["accent", "success", "warning", "danger"].map((tone) => `gallery.tone_${tone}`);
  const badges = [
    ...["tier.hot", "tier.warm", "tier.cool", "role.owner", "role.admin", "role.member"],
    ...tones,
  ];
  await expect(entry(page, "Badge").locator(".wt-badge")).toHaveText(
    badges.map((key) => say(`ui.${key}`)),
  );
  const tooltip = entry(page, "Tooltip");
  await expect(tooltip.getByRole("tooltip")).toBeHidden();
  await tooltip.getByText(say("ui.gallery.tone_accent")).hover();
  await expect(tooltip.getByRole("tooltip")).toHaveText(say("ui.gallery.hint"));
  const empty = entry(page, "EmptyState");
  await expect(empty.getByText(say("ui.state.empty"))).toHaveCount(2);
  await expect(empty.getByRole("button")).toHaveText(say("ui.action.retry"));
  const errors = entry(page, "ErrorState");
  await expect(errors.getByRole("alert")).toHaveCount(2);
  await expect(errors.getByRole("button")).toHaveText(say("ui.action.retry"));
  const loading = entry(page, "LoadingState").getByRole("status");
  await expect(loading).toHaveText(say("ui.state.loading"));
  await expect(entry(page, "Toast").getByRole("status")).toHaveText(say("ui.state.copied"));
  const copy = entry(page, "CopyButton");
  await expect(copy.getByRole("button")).toHaveText(say("ui.action.copy"));
  await expect(copy.getByRole("status")).toBeEmpty();
  await expect(entry(page, "Card").getByRole("region")).toHaveAccessibleName(
    say("ui.gallery.leads"),
  );
  await expect(entry(page, "StatCard").getByRole("definition").first()).toHaveText("1,284");
  // Meter: each part as wide as its share of the track, none for 0, the parts side by side.
  const meters = entry(page, "Meter").locator("svg");
  await expect(meters).toHaveCount(7);
  const shares = await meters.evaluateAll((tracks) =>
    tracks.map((track) => {
      const whole = track.getBoundingClientRect().width;
      const parts = [...track.querySelectorAll("rect")].map((part) => part.getBoundingClientRect());
      return parts.map(({ width }) => Math.round((100 * width) / whole));
    }),
  );
  expect(shares).toEqual([[92], [64], [31], [72], [88], [], [45, 15]]);
  const switches = entry(page, "Switch").getByRole("switch");
  await expect(switches).toHaveCount(3);
  await switches.nth(1).focus();
  await page.keyboard.press("Space");
  await expect(switches.nth(1)).toBeChecked();
  await expect(switches.nth(2)).toBeDisabled();
  await expect(entry(page, "SaveBar").getByText(say("ui.form.unsaved"))).toHaveCount(1);
  const menu = entry(page, "Menu");
  const trigger = menu.getByRole("button", { name: say("ui.gallery.sample_company") });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(menu.getByRole("button", { name: say("ui.action.delete") })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu.getByRole("button", { name: say("ui.action.delete") })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("every word on the page comes from a message key", async ({ page }) => {
  await openGallery(page, keysOnly(text));
  const words = await page.getByRole("main").evaluate((main) => {
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    while (walker.nextNode()) found.push(walker.currentNode.textContent?.trim() ?? "");
    return found.filter(Boolean);
  });
  expect(words.length).toBeGreaterThan(COMPONENTS.length);
  const allowed = new Set([...Object.keys(text), ...COMPONENTS]);
  expect(words.filter((word) => !allowed.has(word))).toEqual([]);
});

test("Escape hides a Tooltip's hint that the pointer opened, the focus elsewhere (WCAG 1.4.13)", async ({
  page,
}) => {
  await openGallery(page, text);
  await entry(page, "Link").getByRole("link").focus();
  const tooltip = entry(page, "Tooltip");
  const trigger = tooltip.getByText(say("ui.gallery.tone_accent"));
  await trigger.hover();
  await expect(tooltip.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip.getByRole("tooltip")).toBeHidden();
  await page.mouse.move(0, 0);
  await trigger.hover();
  await expect(tooltip.getByRole("tooltip")).toBeVisible();
});

test("ErrorState shows the translated text of insufficient_credits, never the code", async ({
  page,
}) => {
  await openGallery(page, text);
  const alerts = entry(page, "ErrorState").getByRole("alert");
  await expect(alerts.first()).toContainText(say("credits.errors.insufficient_credits"));
  await expect(alerts.last()).toContainText(say("platform.error.generic"));
  await expect(page.locator("body")).not.toContainText("insufficient_credits");
});

test("CopyButton copies by keyboard and says so in its live region", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openGallery(page, text);
  const copy = entry(page, "CopyButton");
  await copy.getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(copy.getByRole("status")).toHaveText(say("ui.state.copied"));
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(say("ui.gallery.title"));
});

// axe (MPL-2.0, a test-only devDependency) runs in one test per spec: each comes out with its import.
test("the gallery has no serious or critical accessibility violation (axe), in either theme", async ({
  page,
}) => {
  await openGallery(page, text);
  for (const theme of ["light", "dark"] as const) {
    await entry(page, "ThemeToggle")
      .getByText(say(`ui.theme.${theme}`), { exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    const found = blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`);
    expect(found, `the ${theme} theme`).toEqual([]);
  }
});
