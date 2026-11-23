// campaigns' list and campaign page end to end (gamma-p3-051; core/modules/campaigns/README.md
// "Screens"), in wsp_e2e_campaigns, this spec's alone, whose E2E_USERS are Owners
// (core/apps/api/tests/e2e-server.ts). Each test first has the e2e api's test-only module remove the
// workspace's campaigns, make the signed-in user's LinkedIn account ready to send, give the
// organization its credits and make a draft with the warm-signal default (POST …/e2e/campaigns); the
// rest goes through campaigns', contacts', messaging's and credits' routes. "Campaigns" in the leads
// group, the seeded campaign by its words beside the draft; the editor: a delay changed, a message
// moved, removed and added, saved as version 2 with the emails kept, then a delay off its bounds
// refused by the api's rule, nothing saved; the price of a LinkedIn send on every LinkedIn step and
// in the launch panel, from credits' price list; a message's preview, written by the e2e module in
// the worker's stead, and a failed one's reason, with nothing written on the campaign; the launch
// panel failing on a restricted account, then passing, a launch refused when the account is
// restricted again in between, then Launch; Pause behind its Dialog and Resume; the page at a
// phone's width; another member's campaign, the draft and the seeded one, read-only for a Member, made
// by the e2e module (gamma-p6-015), and its approval mode without the control. The approval mode's
// card (gamma-p4-070): in the campaign's first 7 days, "Review everything until <date>" and "Review
// first touches" off, each channel's AI disclosure line shown before a switch; after them (the e2e
// module's lockEnded), "Review first touches" saved; a light screenshot. Every text from its key;
// axe on each view.
import { AxeBuilder } from "@axe-core/playwright";
import type { APIResponse, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import messaging from "../../../modules/messaging/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_campaigns";
const LIST = `/w/${WORKSPACE}/campaigns`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
const NAME = "Warm signals, spring";
const PHONE = { width: 390, height: 844 };
/** A Member of the workspace, made through the e2e module's members route. */
const MEMBER = { email: "e2e-campaigns-member@example.com", displayName: null, role: "Member" };
const DELAY = { min: 1, max: 30 }; // CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS unset: 1 to 30
const LEAD = {
  slug: "e2e-campaigns-lead",
  firstName: "Dana",
  lastName: "Preview",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
};
const PREVIEW = "Dana, how does the data team at Blue Harbor Labs follow up on warm leads today?";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Step = { stepKey: string; delay: object; condition?: string };
type Campaign = {
  status: string;
  versionNo: number;
  steps: Step[];
  approvalMode: { mode: string; effectiveMode: string; lockedUntil: string };
};
type Price = { action: string; credits: string };

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
  messages: nest({ ...campaigns, ...messaging, ...ui, ...web }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** No serious or critical axe violation on the page as it stands. */
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

/** What is wider than the phone: the document, main or an ancestor of main (phone-width.spec.ts). */
function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const wide: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) wide.push(`document ${root.scrollWidth}`);
    for (let box = document.querySelector("main"); box; box = box.parentElement) {
      if (box.scrollWidth > box.clientWidth) wide.push(`${box.tagName} ${box.scrollWidth}`);
    }
    return wide;
  });
}

/** The routes the tests stand on, as the signed-in user, through the web's /api rewrite. */
function apiOf(page: Page, origin: string) {
  const headers = { origin };
  const ok = async (answer: APIResponse, status = 200) => {
    expect(answer.status(), await answer.text()).toBe(status);
    return answer.json();
  };
  const post = async (path: string, data: object) =>
    ok(await page.request.post(`${API}/e2e/${path}`, { data, headers }));
  return {
    /** No campaign but the draft, the account ready to send and the credits granted: its id. */
    seed: async (lockEnded?: boolean): Promise<string> =>
      ((await post("campaigns", { name: NAME, lockEnded })) as { campaignId: string }).campaignId,
    /** The Member, made a member of the workspace. */
    member: async () => post("members", { members: [MEMBER] }),
    campaign: async (id: string): Promise<Campaign> =>
      ok(await page.request.get(`${API}/campaigns/${id}`)),
    /** A LinkedIn send's price, as credits' route answers it. */
    sendPrice: async (): Promise<Price> => {
      const { prices } = (await ok(await page.request.get(`${API}/credits/prices`))) as {
        prices: Price[];
      };
      const found = prices.find(({ action }) => action === "campaigns.linkedin_send");
      if (found === undefined) throw new Error("no price for campaigns.linkedin_send");
      return found;
    },
    /** The workspace's one lead: its person's id. */
    lead: async (): Promise<string> =>
      ((await post("leads", { leads: [LEAD] })) as { personIds: string[] }).personIds[0] ?? "",
    /** A drafting draft written as its writer leaves it, in the worker's stead. */
    write: async (id: string, columns: object) =>
      expect(await post(`drafts/${id}`, columns)).toEqual({ written: 1 }),
    /** The signed-in user's account restricted, cooling down for an hour, or healthy. */
    health: (state: "restricted" | "healthy") =>
      post("linkedin-health", state === "healthy" ? { state } : { state, cooldownEndsIn: 60 }),
  };
}

/** The price of a LinkedIn send as the kit's PriceTag words it. */
const priceText = ({ credits }: Price) =>
  Number(credits) === 0
    ? t("ui.price.free")
    : t("ui.price.per_unit", { credits: Number(credits), unit: t("campaigns.price.send") });
const step = (key: string) => t(`campaigns.editor.step.${key}`);
const isCall =
  (method: string, path: RegExp) =>
  (r: { request: () => { method: () => string }; url: () => string }) =>
    r.request().method() === method && path.test(new URL(r.url()).pathname);

/** A press lost before the page hydrates is pressed again, until `then` shows. */
async function press(button: Locator, then: Locator) {
  await expect(async () => {
    if (!(await then.isVisible())) await button.click({ timeout: 1_000 });
    await expect(then).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

/** The page's writes to campaigns' routes, from the browser. */
function campaignWrites(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== "GET" && pathname.includes("/campaigns")) sent.push(pathname);
  });
  return sent;
}

/** The editor's card, a message's delay in it, and a step's row of the launch panel. */
function editorOf(page: Page) {
  const card = page.getByRole("region", { name: t("campaigns.editor.steps") });
  const delay = (key: string) =>
    card.getByRole("spinbutton", { name: t("campaigns.editor.delay", { step: step(key) }) });
  const button = (key: string, values?: Record<string, string>) =>
    card.getByRole("button", { name: t(key, values), exact: true });
  return { card, delay, button };
}
const checkOf = (panel: Locator, check: string) =>
  panel.getByRole("listitem").filter({ hasText: t(`campaigns.launch.check.${check}`) });

test("Campaigns lists the seeded campaign and the draft; the editor saves a change as version 2 with the emails kept, a refused rule saves nothing, and every LinkedIn step shows its price", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // two page loads, two saves and three axe runs
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const campaignId = await api.seed();
  const price = await api.sendPrice();
  const first = await api.campaign(campaignId);
  await page.goto(LIST);
  await expect(
    page.getByRole("heading", { level: 1, name: t("campaigns.list.title") }),
  ).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: t("web.nav.leads") });
  const link = group.getByRole("link", { name: t("campaigns.nav.campaigns"), exact: true });
  await expect(link).toHaveAttribute("href", LIST);
  const seeded = page.getByRole("row").filter({ hasText: t("campaigns.list.default_name") });
  await expect(seeded).toContainText(t("campaigns.list.status.active"));
  const draft = page.getByRole("row").filter({ hasText: NAME });
  for (const text of [
    t("campaigns.list.status.draft"),
    t("campaigns.list.version", { version: 1 }),
    t("campaigns.list.not_launched"),
  ]) {
    await expect(draft).toContainText(text);
  }
  await expectAccessible(page);

  await draft.getByRole("link", { name: NAME }).click();
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  const editor = editorOf(page);
  // Each LinkedIn step, the connection request and three messages, with a send's price.
  const tags = editor.card.locator(".wt-price-tag");
  await expect(tags).toHaveCount(4);
  for (const tag of await tags.all()) await expect(tag).toContainText(priceText(price));
  const fallback = editor.card.getByText(t("campaigns.editor.fallback"), { exact: true });
  await expect(fallback).toHaveCount(3);
  const add = editor.button("campaigns.editor.add_step");
  await expect(add).toBeDisabled();
  await expectAccessible(page);

  // Typed, then left: the list has a change, once the page has hydrated.
  const unsaved = editor.card.getByText(t("ui.form.unsaved"), { exact: true });
  await expect(async () => {
    await editor.delay("follow_up_1").fill("2");
    await editor.delay("follow_up_1").press("Tab");
    await expect(unsaved).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await editor.button("ui.list.move_up", { item: step("follow_up_2") }).click();
  await expect(editor.delay("follow_up_1")).toHaveValue("4");
  await expect(editor.delay("follow_up_2")).toHaveValue("2");
  await editor.button("ui.list.remove", { item: step("follow_up_2") }).click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(editor.delay("follow_up_2")).toHaveValue("3");
  await expect(add).toBeDisabled();
  const saved = page.waitForResponse(isCall("PUT", /\/sequence$/));
  await editor.button("ui.action.save").click();
  expect((await saved).status()).toBe(200);
  await expect(editor.card.getByText(t("campaigns.editor.saved", { version: 2 }))).toBeVisible();
  await expect(
    page.getByText(t("campaigns.list.version", { version: 2 }), { exact: true }),
  ).toBeVisible();
  const second = await api.campaign(campaignId);
  const delays = (campaign: Campaign) =>
    campaign.steps.map(({ stepKey, delay }) => [stepKey, delay]);
  expect(second.versionNo).toBe(2);
  expect(delays(second).slice(0, 4)).toEqual([
    ...delays(first).slice(0, 2),
    ["follow_up_1", { anchor: "prev_step", unit: "business_days", value: 4 }],
    ["follow_up_2", { anchor: "prev_step", unit: "business_days", value: 3 }],
  ]);
  // The emails as they were, each with the fallback's condition.
  expect(second.steps.slice(4)).toEqual(first.steps.slice(4));
  expect(second.steps.slice(4).map(({ condition }) => condition)).toEqual(
    Array(3).fill("invite_not_accepted_within"),
  );

  await editor.delay("follow_up_1").fill("45");
  await editor.delay("follow_up_1").press("Tab");
  await expect(editor.card.getByText(t("campaigns.editor.delay_invalid", DELAY))).toBeVisible();
  const refused = page.waitForResponse(isCall("PUT", /\/sequence$/));
  await editor.button("ui.action.save").click();
  expect((await refused).status()).toBe(400);
  await expect(
    editor.card
      .getByRole("alert")
      .filter({ hasText: t("campaigns.sequence_rule.step_delay", DELAY) }),
  ).toBeVisible();
  expect((await api.campaign(campaignId)).versionNo).toBe(2);
  // Enabled by the new delay, Save fades in (the kit's transition): axe reads it once opaque.
  await expect(editor.button("ui.action.save")).toHaveCSS("opacity", "1");
  await expectAccessible(page);
});

test("Preview drafts a LinkedIn message for the chosen lead and shows its text, a failed one its reason, and writes nothing on the campaign; the connection request has no note", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const campaignId = await api.seed();
  const personId = await api.lead();
  const writes = campaignWrites(page);
  await page.goto(`${LIST}/${campaignId}`);
  const previews = page.getByRole("region", { name: t("campaigns.preview.title") });
  await expect(previews.getByRole("combobox", { name: t("campaigns.preview.lead") })).toHaveValue(
    personId,
  );
  await expect(previews.getByText(t("campaigns.preview.connect_note"))).toBeVisible();
  const asked = page.waitForResponse(isCall("POST", /\/messaging\/leads\/[^/]+\/drafts$/));
  const preview = (key: string) =>
    previews.getByRole("button", {
      name: t("campaigns.preview.preview", { step: step(key) }),
      exact: true,
    });
  const writing = previews.getByText(t("campaigns.preview.writing"), { exact: true });
  await press(preview("message_1"), writing);
  const answer = await asked;
  expect(answer.request().postDataJSON()).toEqual({
    channel: "linkedin_message",
    stepKind: "first_message",
  });
  const { id } = (await answer.json()) as { id: string };
  await expect(writing).toBeVisible();
  await api.write(id, { status: "ready", text: PREVIEW });
  await expect(previews.getByText(PREVIEW, { exact: true })).toBeVisible({ timeout: 10_000 });

  const again = page.waitForResponse(isCall("POST", /\/messaging\/leads\/[^/]+\/drafts$/));
  await preview("follow_up_1").click();
  const failed = (await (await again).json()) as { id: string };
  await api.write(failed.id, { status: "failed", flagReasons: [{ code: "profile_not_english" }] });
  const reason = t("campaigns.preview.failure.profile_not_english");
  await expect(previews.getByText(t("campaigns.preview.failed", { reason }))).toBeVisible({
    timeout: 10_000,
  });
  expect(writes).toEqual([]);
  const campaign = await api.campaign(campaignId);
  expect([campaign.status, campaign.versionNo]).toEqual(["draft", 1]);
  await expectAccessible(page);
});

test("the launch panel fails on a restricted account, then passes; a launch refused in between shows its checks; Launch makes the draft active, then Pause asks first and Resume", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // a launch refused, a launch, a pause and a resume
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const campaignId = await api.seed();
  const price = await api.sendPrice();
  await api.health("restricted");
  await page.goto(`${LIST}/${campaignId}`);
  const panel = page.getByRole("region", { name: t("campaigns.launch.title") });
  const sender = checkOf(panel, "linkedin_sender");
  await expect(sender).toContainText(t("campaigns.check.linkedin_sender_unhealthy"));
  await expect(
    sender.getByRole("link", { name: t("campaigns.launch.fix_linkedin") }),
  ).toHaveAttribute("href", `/w/${WORKSPACE}/linkedin`);
  for (const check of ["sending_disclosure", "credits"]) {
    await expect(checkOf(panel, check)).toContainText(t("campaigns.launch.passed"));
  }
  await expect(panel.locator(".wt-price-tag")).toContainText(priceText(price));
  const launch = panel.getByRole("button", { name: t("campaigns.launch.launch"), exact: true });
  const checkAgain = panel.getByRole("button", {
    name: t("campaigns.launch.check_again"),
    exact: true,
  });
  await expect(launch).toBeDisabled();
  await expectAccessible(page);

  await api.health("healthy");
  await press(checkAgain, sender.getByText(t("campaigns.launch.passed"), { exact: true }));
  await expect(launch).toBeEnabled();
  // Restricted again after the screen's read: the launch's own read refuses it.
  await api.health("restricted");
  await launch.click();
  await expect(
    panel.getByRole("alert").filter({ hasText: t("campaigns.errors.campaign_launch_blocked") }),
  ).toBeVisible();
  await expect(sender).toContainText(t("campaigns.check.linkedin_sender_unhealthy"));
  await expect(launch).toBeDisabled();
  expect((await api.campaign(campaignId)).status).toBe("draft");

  await api.health("healthy");
  await checkAgain.click();
  await expect(launch).toBeEnabled();
  await launch.click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(t("campaigns.list.status.active"), { exact: true })).toBeVisible();
  expect((await api.campaign(campaignId)).status).toBe("active");
  await expectAccessible(page);

  await page.getByRole("button", { name: t("campaigns.editor.pause"), exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("campaigns.editor.pause_title") });
  await expect(dialog.getByText(t("campaigns.editor.pause_body"))).toBeVisible();
  // The dialog pops in from transparent (the kit's animation): axe reads it once opaque.
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: t("campaigns.editor.pause"), exact: true }).click();
  await expect(page.getByText(t("campaigns.list.status.paused"), { exact: true })).toBeVisible();
  expect((await api.campaign(campaignId)).status).toBe("paused");
  await page.getByRole("button", { name: t("campaigns.editor.resume"), exact: true }).click();
  await expect(page.getByText(t("campaigns.list.status.active"), { exact: true })).toBeVisible();
  expect((await api.campaign(campaignId)).status).toBe("active");
});

test("the campaign's page fits a phone's width", async ({ page, signInAs, baseURL }) => {
  await signInAs();
  const campaignId = await apiOf(page, baseURL ?? "").seed();
  await page.setViewportSize(PHONE);
  await page.goto(`${LIST}/${campaignId}`);
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page)).toEqual([]);
});

test("a Member sees another member's campaign read-only, with the hint: its name and steps off, no Save, Launch off; the seeded one, its Owner's, with no Pause", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const campaignId = await api.seed();
  await api.member();
  await signInAs(MEMBER.email);
  await page.goto(`${LIST}/${campaignId}`);
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  const main = page.getByRole("main");
  const hint = main.getByText(t("campaigns.editor.not_owner"));
  await expect(hint).toBeVisible();
  await expect(main.getByRole("textbox", { name: t("campaigns.editor.name") })).toBeDisabled();
  const editor = editorOf(page);
  await expect(editor.delay("follow_up_1")).toBeDisabled();
  await expect(editor.button("ui.list.remove", { item: step("follow_up_2") })).toBeDisabled();
  await expect(main.getByRole("button", { name: t("ui.action.save"), exact: true })).toHaveCount(0);
  const panel = page.getByRole("region", { name: t("campaigns.launch.title") });
  const launch = panel.getByRole("button", { name: t("campaigns.launch.launch"), exact: true });
  await expect(launch).toBeDisabled();
  await expectAccessible(page);

  await page.goto(LIST);
  const seeded = page.getByRole("row").filter({ hasText: t("campaigns.list.default_name") });
  await seeded.getByRole("link", { name: t("campaigns.list.default_name") }).click();
  await expect(page.getByText(t("campaigns.list.status.active"), { exact: true })).toBeVisible();
  await expect(hint).toBeVisible();
  const pause = page.getByRole("button", { name: t("campaigns.editor.pause"), exact: true });
  await expect(pause).toHaveCount(0);
  const mode = page.getByRole("region", { name: t("campaigns.approval_mode.title") });
  await expect(mode.getByText(t("campaigns.approval_mode.review_everything_hint"))).toBeVisible();
  await expect(mode.getByRole("radio")).toHaveCount(0);
});

/** The lock's end as the approval mode's card words it: a medium date in the browser's zone. */
async function lockedUntil(page: Page, at: string): Promise<string> {
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const onError = (error: Error) => {
    throw error;
  };
  const dated = createTranslator({ locale: "en", messages: nest(campaigns), timeZone, onError });
  const words = dated as unknown as (key: string, values: { date: Date }) => string;
  return words("campaigns.approval_mode.locked_until", { date: new Date(at) });
}

test("the approval mode: in the campaign's first 7 days, Review everything until their end and Review first touches off, each channel's AI disclosure line shown before a switch; after them, Review first touches saved; axe; a light screenshot", async ({
  page,
  signInAs,
  baseURL,
}, testInfo) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const lockedId = await api.seed();
  const { approvalMode } = await api.campaign(lockedId);
  expect(approvalMode.effectiveMode).toBe("review_everything");
  await page.goto(`${LIST}/${lockedId}`);
  const card = page.getByRole("region", { name: t("campaigns.approval_mode.title") });
  const until = await lockedUntil(page, approvalMode.lockedUntil);
  const firstTouches = card.getByRole("radio", {
    name: t("campaigns.approval_mode.review_first_touches"),
  });
  const save = card.getByRole("button", { name: t("campaigns.approval_mode.save"), exact: true });
  await expect(card.getByRole("radio", { name: until })).toBeChecked();
  await expect(firstTouches).toBeDisabled();
  for (const key of ["messaging.disclosure.linkedin", "messaging.disclosure.email"]) {
    await expect(card.getByText(t(key), { exact: true })).toBeVisible();
  }
  await expect(save).toBeDisabled();
  await expectAccessible(page);

  const liftedId = await api.seed(true);
  await page.goto(`${LIST}/${liftedId}`);
  const everything = card.getByRole("radio", {
    name: t("campaigns.approval_mode.review_everything"),
  });
  await expect(everything).toBeChecked();
  // A choice lost before the page hydrates is made again, until Save is on.
  await expect(async () => {
    await firstTouches.check({ timeout: 1_000 });
    await expect(save).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  const saved = page.waitForResponse(isCall("PUT", /\/approval-mode$/));
  await save.click();
  expect((await saved).status()).toBe(200);
  await expect(card.getByText(t("campaigns.approval_mode.saved"), { exact: true })).toBeVisible();
  await expect(firstTouches).toBeChecked();
  const { approvalMode: after } = await api.campaign(liftedId);
  expect([after.mode, after.effectiveMode]).toEqual([
    "review_first_touches",
    "review_first_touches",
  ]);
  await expectAccessible(page);
  await card.screenshot({ path: testInfo.outputPath("approval-mode.png") });
});
