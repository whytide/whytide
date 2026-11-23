// The ICP screen's draft card end to end (icp-draft-screen; core/modules/icp/README.md "The screen"),
// on the e2e api, which runs no worker: the card's presses call the real routes, and the e2e module's
// POST …/e2e/icp-draft writes the ICP's draft as the drafter leaves it, which the card's next read
// shows. The tests share the workspace's ICP, wsp_e2e_icp_draft, this spec's alone
// (core/apps/api/tests/e2e-server.ts), so they run in this file only, one after the other; each first
// puts the ICP, its draft and Company Knowledge back through the api.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import icp from "../../../modules/icp/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_icp_draft";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const messages: Record<string, string> = { ...ui, ...icp };
const EMPTY_ICP = {
  name: "",
  titles: [],
  seniorities: [],
  industries: [],
  sizeRanges: [],
  countries: [],
  mustHaves: "",
  disqualifiers: "",
};
const EMPTY_COMPANY = {
  sourceUrl: null,
  oneLiner: "",
  longDescription: "",
  products: [],
  painPoints: [],
  featuresBenefits: [],
  proofPoints: [],
  competitors: [],
  tone: "",
};
/** What the drafter proposes, within its schema (icp's schemas/draft-profile.ts). */
const PROPOSAL = {
  name: "Bakery owners",
  titles: ["Owner", "Head of Finance"],
  seniorities: ["owner_founder", "head"],
  industries: ["Food and beverage"],
  sizeRanges: ["11-50"],
  countries: ["FR", "BE"],
  mustHaves: "Runs two bakeries or more",
  disqualifiers: "",
};

/** The text of a key with its values put in; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const message = messages[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return message.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

type Setup = { page: Page; baseURL?: string };

/** The worker's part, which the e2e api does not run: the ICP's draft as the drafter leaves it. */
async function worker({ page, baseURL }: Setup, draft: object): Promise<void> {
  const headers = { origin: baseURL ?? "" };
  const answer = await page.request.post(`${API}/e2e/icp-draft`, { data: draft, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  expect(await answer.json()).toEqual({ updated: 1 });
}

/**
 * Company Knowledge with a one-liner, or empty; the ICP empty but for `start`, with no draft; then
 * the screen. The ICP's version is the answer.
 */
async function open(setup: Setup, knowledge: boolean, start = {}): Promise<number> {
  const { page, baseURL } = setup;
  const headers = { origin: baseURL ?? "" };
  const company = { ...EMPTY_COMPANY, oneLiner: knowledge ? "Bookkeeping for bakeries" : "" };
  const saved = await page.request.put(`${API}/onboarding/company-knowledge`, {
    data: company,
    headers,
  });
  expect(saved.status()).toBe(200);
  const answer = await page.request.put(`${API}/icp`, {
    data: { ...EMPTY_ICP, ...start },
    headers,
  });
  expect(answer.status()).toBe(200);
  await worker(setup, { status: "none" });
  await page.goto(`/w/${WORKSPACE}/icp`);
  return ((await answer.json()) as { version: number }).version;
}

const card = (page: Page) => page.locator('[data-part="icp-draft"]');
const heading = (page: Page) => card(page).getByRole("heading", { level: 2 });
const proposed = (page: Page, field: string) => card(page).locator(`[data-proposal="${field}"]`);
const button = (page: Page, key: string) => card(page).getByRole("button", { name: say(key) });

async function expectAxe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("Draft shows the drafting line, then the proposal by its labels; axe passes; Use asks first over targeting, then fills the form, moves the version badge and says it was saved", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const version = await open({ page, baseURL }, true, { titles: ["CFO"] });
  await expect(heading(page)).toHaveText(say("icp.draft.title"));
  await card(page).getByLabel(say("icp.draft.brief")).fill("Bakeries in France and Belgium");
  await button(page, "icp.draft.start").click();
  await expect(card(page).getByRole("status")).toHaveText(say("icp.draft.drafting"));

  await worker({ page, baseURL }, { status: "drafted", fields: PROPOSAL });
  await expect(heading(page)).toHaveText(say("icp.draft.ready"), { timeout: 10_000 });
  await expect(proposed(page, "name")).toContainText("Bakery owners");
  await expect(proposed(page, "titles").getByRole("listitem")).toHaveText(PROPOSAL.titles);
  await expect(proposed(page, "seniorities").getByRole("listitem")).toHaveText([
    say("icp.seniority.owner_founder"),
    say("icp.seniority.head"),
  ]);
  await expect(proposed(page, "sizeRanges").getByRole("listitem")).toHaveText([
    say("icp.size.from_11_to_50"),
  ]);
  await expect(proposed(page, "countries").getByRole("listitem")).toHaveText(["France", "Belgium"]);
  await expect(proposed(page, "disqualifiers")).toContainText(say("icp.draft.empty"));
  await expect(card(page)).toContainText(say("icp.screen.rescore_note"));
  await expectAxe(page);

  await button(page, "icp.draft.use").click();
  const dialog = page.getByRole("dialog", { name: say("icp.draft.confirm_title") });
  await expect(dialog).toContainText(say("icp.draft.confirm"));
  await dialog.getByRole("button", { name: say("icp.draft.use") }).click();
  await expect(page.getByText(say("icp.screen.saved"), { exact: true })).toBeVisible();
  const badge = say("icp.screen.version", { version: version + 1 });
  await expect(page.getByText(badge, { exact: true })).toBeVisible();
  const name = page.getByRole("textbox", { name: say("icp.screen.name"), exact: true });
  await expect(name).toHaveValue("Bakery owners");
  const titles = page.getByRole("list", { name: say("icp.screen.titles"), exact: true });
  await expect(titles.getByRole("listitem")).toHaveText(PROPOSAL.titles);
  await expect(heading(page)).toHaveText(say("icp.draft.title"));

  await page.reload();
  await expect(name).toHaveValue("Bakery owners");
  await expect(page.getByText(badge, { exact: true })).toBeVisible();
  await expect(proposed(page, "name")).toHaveCount(0);
});

test("Discard empties the card, and a reload shows none; the ICP keeps its fields", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const version = await open({ page, baseURL }, true, { titles: ["CFO"] });
  await worker({ page, baseURL }, { status: "drafted", fields: PROPOSAL });
  await page.reload();
  await expect(heading(page)).toHaveText(say("icp.draft.ready"));
  await button(page, "icp.draft.discard").click();
  await expect(heading(page)).toHaveText(say("icp.draft.title"));
  await expect(card(page).locator("[data-proposal]")).toHaveCount(0);

  await page.reload();
  await expect(button(page, "icp.draft.start")).toBeVisible();
  await expect(card(page).locator("[data-proposal]")).toHaveCount(0);
  const stored = (await (await page.request.get(`${API}/icp`)).json()) as Record<string, unknown>;
  expect([stored.titles, stored.version]).toEqual([["CFO"], version]);
});

test("an empty Company Knowledge: the card says so and links to the Company screen; Draft waits for a brief; axe passes", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await open({ page, baseURL }, false);
  const line = say("icp.draft.no_knowledge");
  await expect(card(page)).toContainText(line.replace(/<\/?link>/g, ""));
  const linked = /<link>(.*)<\/link>/.exec(line)?.[1] ?? line;
  const link = card(page).getByRole("link", { name: linked });
  await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/company`);
  const start = button(page, "icp.draft.start");
  await expect(start).toBeDisabled();
  await expectAxe(page);
  await card(page).getByLabel(say("icp.draft.brief")).fill("Bakeries in France");
  await expect(start).toBeEnabled();
});

test("a failed draft shows its code in words, never the code, with Draft again", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await open({ page, baseURL }, true);
  await worker({ page, baseURL }, { status: "failed", error: "ai_failed" });
  await page.reload();
  const alert = card(page).getByRole("alert");
  await expect(alert).toContainText(say("icp.draft.failed"));
  await expect(alert).toContainText(say("icp.errors.ai_failed"));
  await expect(alert).not.toContainText("ai_failed");
  await expect(button(page, "icp.draft.again")).toBeEnabled();
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the drafted card, a title without a space among its values, is no wider than the phone", async ({
    page,
    signInAs,
    baseURL,
  }) => {
    await signInAs();
    await open({ page, baseURL }, true);
    const long = { ...PROPOSAL, titles: ["x".repeat(100)], industries: ["y".repeat(100)] };
    await worker({ page, baseURL }, { status: "drafted", fields: long });
    await page.reload();
    await expect(heading(page)).toHaveText(say("icp.draft.ready"));
    const wide = await page.evaluate(() => {
      const found: string[] = [];
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth) found.push(`document ${root.scrollWidth}`);
      for (let box = document.querySelector("main"); box; box = box.parentElement) {
        if (box.scrollWidth > box.clientWidth) found.push(`${box.tagName} ${box.scrollWidth}`);
      }
      return found;
    });
    expect(wide).toEqual([]);
  });
});
