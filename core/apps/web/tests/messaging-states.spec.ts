// messaging's draft panel, its states and the gaps of its polish (alpha-p10-140;
// core/modules/messaging/README.md "The draft panel"), on a lead and drafts that the e2e api's
// test-only module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_messaging, this spec's
// alone: the slot loading while the e2e api holds the drafts' read, the empty state, the panel's
// error state when it fails that read, and its retry (tests/e2e-hold.ts); the stale note, then the
// facts loading in the browser and shown; a message's range; each draft's model and prompt version
// on hover and focus; a refused Draft with its code in words and a retry with the same key; a draft
// being written asked for less often as it ages, and no more past twenty minutes; Copy by the keyboard,
// announced (Chromium alone grants the clipboard). Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page, Request } from "@playwright/test";
import { createTranslator } from "next-intl";
import messaging from "../../../modules/messaging/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_messaging";
const E2E = `/api/v1/workspaces/${WORKSPACE}/e2e`;
const LEAD = {
  slug: "e2e-messaging-lead",
  firstName: "State",
  lastName: "Lead",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
};
const NOTE = "State, how does the data team at Blue Harbor Labs follow up on warm leads today?";
const AGAIN =
  "State, a short question for the Head of Data at Blue Harbor Labs: who answers leads?";
const MESSAGE =
  "State, teams like the one you lead at Blue Harbor Labs often lose warm leads between a signal and the first message. Would a short note on how other data teams close that gap be useful to you?";
/** The writer's range for a message (README.md "The writer"). */
const RANGE = { low: 150, high: 300 };

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Dossier = { dossierHash: string; facts: { id: string; sourceRef: string }[] };

/** The keys nested as the web's bundle holds them; a key missing from the messages fails. */
function nest(flat: Record<string, string>) {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const path = key.split(".");
    const last = path.pop() ?? key;
    let node = root;
    for (const part of path) node = (node[part] ??= {}) as Record<string, unknown>;
    node[last] = value;
  }
  return root;
}
const t = createTranslator({
  locale: "en",
  messages: nest({ ...messaging, ...platform, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** A ready note written in the dossier on three of its facts, unless `change` says otherwise. */
const written = (dossier: Dossier, text: string, change: Record<string, unknown> = {}) => {
  const fact = (column: string) => dossier.facts.find((f) => f.sourceRef.endsWith(`/${column}`));
  const factIds = ["first_name", "title", "company_name"].map((column) => fact(column)?.id);
  const plan = { angle: "pain_point", factIds, cta: "question" };
  return { status: "ready", plan, text, dossierHash: dossier.dossierHash, ...change };
};

/** The workspace's one lead, its dossier and its drafts as `drafts` builds them, oldest first. */
async function seed(
  page: Page,
  origin?: string,
  drafts: (dossier: Dossier) => object[] = () => [],
) {
  const headers = { origin: origin ?? "" };
  const leads = await page.request.post(`${E2E}/leads`, { data: { leads: [LEAD] }, headers });
  expect(leads.status(), await leads.text()).toBe(200);
  const [personId = ""] = ((await leads.json()) as { personIds: string[] }).personIds;
  const read = await page.request.get(
    `/api/v1/workspaces/${WORKSPACE}/messaging/leads/${personId}/dossier`,
  );
  expect(read.status(), await read.text()).toBe(200);
  const dossier = (await read.json()) as Dossier;
  const data = { personId, drafts: drafts(dossier) };
  const seeded = await page.request.post(`${E2E}/drafts`, { data, headers });
  expect(seeded.status(), await seeded.text()).toBe(200);
  const { draftIds } = (await seeded.json()) as { draftIds: string[] };
  return { personId, dossier, draftIds };
}

/** The draft written as its writer leaves it, by the e2e module in the worker's stead. */
async function write(page: Page, origin: string | undefined, id: string, columns: object) {
  const url = `${E2E}/drafts/${id}`;
  const answer = await page.request.post(url, { data: columns, headers: { origin: origin ?? "" } });
  expect(await answer.json()).toEqual({ written: 1 });
}

/** The e2e api holds (`e2e_hold`) or fails (`e2e_fail`) each read of a path ending so. */
const cookie = (context: BrowserContext, origin: string | undefined, name: string, path: string) =>
  context.addCookies([{ name, value: encodeURIComponent(path), url: origin ?? "" }]);

/** A press lost before the page hydrates is pressed again, until `then` shows. */
async function press(button: Locator, then: Locator) {
  await expect(async () => {
    if (!(await then.isVisible())) await button.click({ timeout: 1_000 });
    await expect(then).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: t("messaging.draft.title") });
const draftOf = (panel: Locator) => panel.locator('[data-part="draft"]');
const listOf = (scope: Locator, key: string) =>
  scope.getByRole("list", { name: t(key), exact: true });
const button = (scope: Locator, key: string) =>
  scope.getByRole("button", { name: t(key), exact: true });
const status = (scope: Locator, key: string) =>
  scope.getByRole("status").filter({ hasText: t(key) });
const is = (method: string, path: RegExp) => (request: Request) =>
  request.method() === method && path.test(new URL(request.url()).pathname);

test("the slot loads while the api holds the drafts' read, then a person without a draft is the empty state; a read the api fails is the panel's error state, whose retry reads the page again; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { personId } = await seed(page, baseURL);
  const drafts = `/messaging/leads/${personId}/drafts`;
  await cookie(context, baseURL, "e2e_hold", drafts);
  await page.goto(leadPath(personId), { waitUntil: "commit" });
  await expect(page.locator('[data-slot="draft"]').getByRole("status")).toHaveText(
    t("ui.state.loading"),
  );
  await axe(page);
  const panel = panelOf(page);
  const empty = panel.getByText(t("messaging.draft.empty"), { exact: true });
  await expect(empty).toBeVisible();
  await expect(listOf(panel, "messaging.draft.history")).toHaveCount(0);
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });

  await cookie(context, baseURL, "e2e_fail", drafts);
  await page.reload();
  const alert = panel.getByRole("alert");
  await expect(panel.getByText(t("messaging.draft.error"), { exact: true })).toBeVisible();
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  // The rest of the page stands.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("State Lead");
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await alert.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(empty).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("a draft written on another dossier than today's says so, with the Regenerate hint and no facts; Regenerate's draft, written on today's, shows its facts once the browser has read them, loading meanwhile; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const older = (d: Dossier) => [written(d, NOTE, { dossierHash: "0".repeat(64) })];
  const { personId, dossier } = await seed(page, baseURL, older);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const current = draftOf(panel);
  const stale = current.getByText(t("messaging.draft.stale"), { exact: true });
  await expect(stale).toBeVisible();
  await expect(current.getByRole("heading", { name: t("messaging.draft.facts") })).toHaveCount(0);
  await axe(page);

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const isDossier = (url: URL) => url.pathname.endsWith(`/messaging/leads/${personId}/dossier`);
  await page.route(
    isDossier,
    async (route) => {
      await held;
      await route.fallback();
    },
    { times: 1 },
  );
  const answered = page.waitForRequest(is("POST", /\/messaging\/drafts\/[^/]+\/regenerate$/));
  await press(
    button(current, "messaging.draft.regenerate"),
    status(panel, "messaging.draft.drafting"),
  );
  const again = (await (await (await answered).response())?.json()) as { id: string };
  await write(page, baseURL, again.id, written(dossier, AGAIN));
  await expect(status(current, "messaging.draft.loading")).toBeVisible({ timeout: 10_000 });
  await expect(current.getByText(AGAIN, { exact: true })).toBeVisible();
  await expect(stale).toHaveCount(0);
  await axe(page);
  release();
  const source = (column: string) => t("messaging.draft.source.persons", { column });
  await expect(listOf(current, "messaging.draft.facts").getByRole("listitem")).toHaveText([
    `State ${source("first_name")}`,
    `Head of Data ${source("title")}`,
    `Blue Harbor Labs ${source("company_name")}`,
  ]);
  await expect(status(current, "messaging.draft.loading")).toHaveCount(0);
});

test("a message's counter says the range it aims for; each draft of the history shows its model and prompt version while hovered, or while its time has the keyboard's focus; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { personId } = await seed(page, baseURL, (d) => [
    written(d, NOTE, { modelId: "fake/model-a", promptVersion: 1 }),
    written(d, MESSAGE, { channel: "linkedin_message", modelId: "fake/model-b", promptVersion: 2 }),
  ]);
  const list = await page.request.get(
    `/api/v1/workspaces/${WORKSPACE}/messaging/leads/${personId}/drafts`,
  );
  const [newest] = ((await list.json()) as { drafts: { maxCharacters: number }[] }).drafts;
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const count = { count: MESSAGE.length, max: newest?.maxCharacters ?? 0, ...RANGE };
  await expect(
    draftOf(panel).getByText(t("messaging.draft.range", count), { exact: true }),
  ).toBeVisible();

  const history = listOf(panel, "messaging.draft.history").getByRole("listitem");
  const hint = (item: Locator) => item.getByRole("tooltip");
  const time = (item: Locator) => item.locator('[tabindex="0"]');
  const info = (model: string, version: number) =>
    t("messaging.draft.model_info", { model, version });
  await expect(hint(history.nth(0))).toBeHidden();
  await history.nth(0).hover();
  await expect(hint(history.nth(0))).toHaveText(info("fake/model-b", 2));
  await history.nth(1).hover();
  await expect(hint(history.nth(1))).toHaveText(info("fake/model-a", 1));
  await expect(hint(history.nth(0))).toBeHidden();
  await axe(page);
  await page.mouse.move(0, 0);
  await time(history.nth(0)).focus();
  await page.keyboard.press("Tab");
  await expect(time(history.nth(1))).toBeFocused();
  await expect(hint(history.nth(1))).toBeVisible();
  await expect(time(history.nth(1))).toHaveAccessibleDescription(info("fake/model-a", 1));
});

test("a Draft the api refuses shows the code in messaging's words and a retry, which sends it again with the same key; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { personId } = await seed(page, baseURL);
  const keys: string[] = [];
  const isAsk = is("POST", /\/messaging\/leads\/[^/]+\/drafts$/);
  page.on("request", (request) => {
    if (isAsk(request)) keys.push(request.headers()["idempotency-key"] ?? "");
  });
  const refused = { status: 500, json: { code: "writer_agent_not_loaded" } };
  await page.route(
    (url) => url.pathname.endsWith(`/messaging/leads/${personId}/drafts`),
    (route) => (isAsk(route.request()) ? route.fulfill(refused) : route.fallback()),
    { times: 1 },
  );
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const alert = panel.getByRole("alert");
  await press(button(panel, "messaging.draft.create"), alert);
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("messaging.errors.writer_agent_not_loaded"));
  await axe(page);
  await alert.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(status(panel, "messaging.draft.drafting")).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("a draft being written is asked for less often as it ages, and no more past twenty minutes: a note says so, and Check again reads it once; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const drafting = { status: "drafting", modelId: null, promptVersion: null, gates: [] };
  const { personId, dossier, draftIds } = await seed(page, baseURL, () => [drafting]);
  const [id = ""] = draftIds;
  const polls: string[] = [];
  const isPoll = is("GET", new RegExp(`/messaging/drafts/${id}$`));
  page.on("request", (request) => {
    if (isPoll(request)) polls.push(request.url());
  });
  // The page's clock a minute and a half after the draft was asked for: one read in eleven seconds.
  await page.clock.setFixedTime(Date.now() + 90_000);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  await expect(status(panel, "messaging.draft.drafting")).toBeVisible();
  await page.waitForTimeout(5_000);
  expect(polls).toEqual([]);

  await page.clock.setFixedTime(Date.now() + 21 * 60_000);
  await page.reload();
  const note = panel.getByText(t("messaging.draft.stuck", { minutes: 20 }), { exact: true });
  await expect(note).toBeVisible();
  await expect(button(panel, "messaging.draft.create")).toBeDisabled();
  await axe(page);
  await page.waitForTimeout(3_000);
  expect(polls).toEqual([]);
  await write(page, baseURL, id, written(dossier, NOTE));
  await press(
    button(panel, "messaging.draft.check"),
    draftOf(panel).getByText(NOTE, { exact: true }),
  );
  await expect(note).toHaveCount(0);
  expect(polls).toHaveLength(1);
});

test("Copy, reached and pressed by the keyboard, puts the text on the clipboard and announces it in the panel's live region; axe", async ({
  page,
  context,
  signInAs,
  baseURL,
  browserName,
}) => {
  // Only Chromium lets a test grant the clipboard's permissions; the full pipeline runs the others.
  test.skip(browserName !== "chromium", "the clipboard's permissions are Chromium's");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAs();
  const { personId } = await seed(page, baseURL, (d) => [written(d, NOTE)]);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const copy = button(draftOf(panel), "messaging.draft.copy");
  const announced = status(panel, "messaging.draft.copied");
  // From Draft, the next stop is Copy; a key pressed before the page hydrates is pressed again.
  await expect(async () => {
    await button(panel, "messaging.draft.create").focus();
    await page.keyboard.press("Tab");
    await expect(copy).toBeFocused({ timeout: 1_000 });
    await page.keyboard.press("Enter");
    await expect(announced).toBeVisible({ timeout: 1_000 });
  }).toPass();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(NOTE);
  await axe(page);
});
