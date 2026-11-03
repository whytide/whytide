// The draft review end to end (alpha-p4-030; core/modules/onboarding/README.md "The screen"). The e2e
// api runs no worker: its test route writes the record as the drafter leaves it (e2e-onboarding.ts in
// core/apps/api/tests), then the screen calls the real accept and discard routes. Accept with "Replace
// my edits" is alpha-p10-090's; a value from a document, knowledge-draft's. The tests share the
// workspace's record, so they run in this file only, one after the other.
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const C = "wsp_e2e_c"; // the draft review's own workspace: no other spec writes its record
const SEED = `http://127.0.0.1:${process.env.API_PORT}/test/onboarding/draft`;
const messages: Record<string, string> = { ...onboarding, ...ui };
/** The seeded record's one-liner, a person's, and the draft's values (e2e-onboarding.ts). */
const OWN = "Parcels for small shops, by bike";
const DRAFTED = {
  oneLiner: "Corvid moves parcels for small shops.",
  longDescription: "Corvid carries the parcels of small shops across town by bike.",
};

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** The record as the drafter leaves it, then the screen. */
type Outcome = "drafted" | "failed" | "documented";
async function open(page: Page, request: APIRequestContext, outcome: Outcome) {
  const seeded = await request.post(`${SEED}/${outcome}`);
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);
  await page.goto(`/w/${C}/company`);
}
const field = (page: Page, key: string) => page.getByLabel(say(key), { exact: true });
const review = (page: Page) => page.locator('[data-part="draft-review"]');
const badge = (page: Page, name: string, key: string) =>
  page.locator(`[data-field="${name}"]`).getByText(say(key), { exact: true });

test("the draft next to the record, a link per value; Accept fills the empty fields, keeps the edited one-liner, shows AI-draft badges; axe passes", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  await open(page, request, "drafted");
  const panel = review(page);
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
    say("onboarding.company.draft_ready"),
  );
  const row = (name: string) => panel.locator(`[data-review-field="${name}"]`);
  await expect(panel.locator("[data-review-field]")).toHaveCount(4);
  const current = row("oneLiner").locator('[data-side="current"]');
  await expect(current).toContainText(OWN);
  await expect(current).toContainText(say("onboarding.company.source.human"));
  await expect(row("oneLiner").locator('[data-side="draft"]')).toContainText(DRAFTED.oneLiner);
  const pages = row("products").getByRole("link", { name: say("onboarding.company.source.page") });
  await expect(pages).toHaveCount(2);
  await expect(row("longDescription").getByRole("link")).toHaveAttribute(
    "href",
    "https://corvid.test/about",
  );
  await expect(panel.getByLabel(say("onboarding.company.replace_edited"))).not.toBeChecked();
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  await panel.getByRole("button", { name: say("onboarding.company.accept") }).click();
  await expect(panel).toHaveCount(0);
  await expect(field(page, "onboarding.company.one_liner")).toHaveValue(OWN);
  await expect(field(page, "onboarding.company.long_description")).toHaveValue(
    DRAFTED.longDescription,
  );
  await expect(page.locator('[data-field="products"]')).toContainText("Same-day parcels");
  for (const name of ["longDescription", "products", "proofPoints"]) {
    await expect(badge(page, name, "onboarding.company.source.ai_draft")).toBeVisible();
  }
  await expect(badge(page, "oneLiner", "onboarding.company.source.human")).toBeVisible();
  await page.reload();
  await expect(field(page, "onboarding.company.long_description")).toHaveValue(
    DRAFTED.longDescription,
  );
  await expect(review(page)).toHaveCount(0);
});

test("a value from a document shows the document's name, never a link; after Accept the field's source does too, and a save with it passes", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  await open(page, request, "documented");
  const deck = say("onboarding.company.source.document").replace("{name}", "deck.pdf");
  const panel = review(page);
  const drafted = (name: string) =>
    panel.locator(`[data-review-field="${name}"] [data-side="draft"]`);
  await expect(drafted("proofPoints").locator('[data-source="document"]')).toHaveText(deck);
  await expect(drafted("proofPoints").getByRole("link")).toHaveCount(0);
  await expect(drafted("products").locator('[data-source="document"]')).toHaveText(deck);
  await expect(drafted("products").getByRole("link")).toHaveCount(1);
  await panel.getByRole("button", { name: say("onboarding.company.accept") }).click();
  await expect(panel).toHaveCount(0);
  const proofPoints = page.locator('[data-field="proofPoints"]');
  await expect(proofPoints.locator('[data-source="document"]')).toHaveText(deck);
  await expect(proofPoints.getByRole("link")).toHaveCount(0);

  // The save sends the proof point back with its document's source: the api takes it.
  await field(page, "onboarding.company.tone").fill("Plain and short");
  await page.getByRole("button", { name: say("ui.action.save") }).click();
  await expect(page.getByText(say("onboarding.company.saved"))).toBeVisible();
  await page.reload();
  await expect(field(page, "onboarding.company.tone")).toHaveValue("Plain and short");
  await expect(proofPoints.locator('[data-source="document"]')).toHaveText(deck);
  await expect(proofPoints).toContainText("Trusted by 300 shops");
});

test("Accept with Replace my edits replaces the edited one-liner too, as an AI draft", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  await open(page, request, "drafted");
  const panel = review(page);
  await panel.getByLabel(say("onboarding.company.replace_edited")).check();
  await panel.getByRole("button", { name: say("onboarding.company.accept") }).click();
  await expect(panel).toHaveCount(0);
  await expect(field(page, "onboarding.company.one_liner")).toHaveValue(DRAFTED.oneLiner);
  await expect(badge(page, "oneLiner", "onboarding.company.source.ai_draft")).toBeVisible();
  await page.reload();
  await expect(field(page, "onboarding.company.one_liner")).toHaveValue(DRAFTED.oneLiner);
  await expect(badge(page, "oneLiner", "onboarding.company.source.human")).toHaveCount(0);
});

test("Discard drops the draft and changes nothing", async ({ page, request, signInAs }) => {
  await signInAs();
  await open(page, request, "drafted");
  await review(page)
    .getByRole("button", { name: say("onboarding.company.discard") })
    .click();
  await expect(review(page)).toHaveCount(0);
  await page.reload();
  await expect(review(page)).toHaveCount(0);
  await expect(field(page, "onboarding.company.one_liner")).toHaveValue(OWN);
  await expect(field(page, "onboarding.company.long_description")).toHaveValue("");
  await expect(badge(page, "longDescription", "onboarding.company.source.ai_draft")).toHaveCount(0);
});

test("a failed draft shows its reason in words, never its code, and nothing to review", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  await open(page, request, "failed");
  const alert = page.locator('[data-part="website-fetch"]').getByRole("alert");
  await expect(alert).toContainText(say("onboarding.company.draft_failed"));
  await expect(alert).toContainText(say("onboarding.errors.ai_failed"));
  await expect(alert).not.toContainText("ai_failed");
  await expect(review(page)).toHaveCount(0);
});
