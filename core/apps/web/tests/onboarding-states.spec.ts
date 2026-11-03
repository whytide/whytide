// The Company Knowledge screen's states and gaps end to end (alpha-p10-090, acceptance criteria 1 and
// 2; core/modules/onboarding/README.md "The screen"), in the import workspace, whose Company
// Knowledge no other spec reads or writes, and this one neither: Playwright answers each call of the
// screen as the api, or the worker after it, would, a failure among them. The record loading, failed
// with a retry, then empty, and a failed Save retried; the pages read while the worker reads them, a
// failed read with a retry, each page linked, then none; a run stuck for eleven minutes; a second
// Draft that asks first, then fails and is retried with its key; the source badges' hints on hover
// and on keyboard focus, and the last-changed line; the draft review with nothing in it, then an
// Accept held, failed and retried with its key. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2eimport"; // the e2e api's import workspace (e2e-server.ts)
const RECORD = "**/api/v1/workspaces/*/onboarding/company-knowledge";
const messages: Record<string, string> = { ...onboarding, ...platform, ...ui };
const failed = { status: 500, json: { code: "internal_error" } };
const SITE = "https://corvid.test/";
const cite = (text: string, path = "") => ({ text, sourceUrl: `${SITE}${path}`, quote: text });
/** A pending draft as the drafter leaves it: a one-liner and a product. */
const DRAFT = {
  model: "fake-model",
  promptVersion: 1,
  decisionRecordId: "dec_states",
  fields: {
    oneLiner: cite("Corvid moves parcels for small shops."),
    longDescription: null,
    products: [cite("Same-day parcels", "about")],
    painPoints: [],
    featuresBenefits: [],
    proofPoints: [],
    competitors: [],
    tone: null,
  },
};

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

/** The words of one case of a key's select, `{kind, select, <value> {words} …}`. */
function chosen(key: string, value: string): string {
  const words = new RegExp(`[{\\s]${value} \\{([^{}]*)\\}`).exec(say(key))?.[1];
  if (words === undefined) throw new Error(`no case ${value} in ${key}`);
  return words;
}

/** The record as the api answers it: an empty one, then `change`. */
function knowledge(change: Record<string, unknown> = {}) {
  return {
    id: "ck_states",
    sourceUrl: null,
    fetchStatus: "none",
    fetchedAt: null,
    fetchError: null,
    oneLiner: "",
    longDescription: "",
    products: [],
    painPoints: [],
    featuresBenefits: [],
    proofPoints: [],
    competitors: [],
    tone: "",
    fieldSources: {},
    version: 1,
    updatedAt: new Date().toISOString(),
    pendingDraft: null,
    pages: [],
    ...change,
  };
}

async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const fetchPart = (page: Page) => page.locator('[data-part="website-fetch"]');
const review = (page: Page) => page.locator('[data-part="draft-review"]');
const retry = (page: Page) => page.getByRole("button", { name: say("ui.action.retry") });

test("the record loads while the api is held, fails with the code in words and a retry, and the retry shows it empty; a Save the api fails has a retry, which sends the form again; axe passes on each", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const held = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(RECORD, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads += 1;
    if (reads > 1) return route.fulfill({ json: knowledge() });
    await held.promise;
    await route.fulfill(failed);
  });
  await page.goto(`/w/${WORKSPACE}/company`);
  const loading = page.getByRole("region", { name: say("onboarding.company.loading") });
  await expect(loading.getByRole("status")).toHaveText(say("ui.state.loading"));
  await axe(page);
  held.resolve();
  const error = page.getByRole("region", { name: say("onboarding.company.error") });
  await expect(error.getByRole("alert")).toContainText(say("ui.state.error"));
  await expect(error.getByRole("alert")).toContainText(say("platform.error.generic"));
  await axe(page);
  await retry(page).click();
  await expect(page.getByText(say("onboarding.company.empty"))).toBeVisible();
  await expect(page.getByLabel(say("onboarding.company.source_url"), { exact: true })).toHaveValue(
    "",
  );
  expect(reads).toBe(2);
  await axe(page);

  const text = "Parcels for small shops, by bike";
  const at = new Date().toISOString();
  const saved = knowledge({ oneLiner: text, fieldSources: { oneLiner: { kind: "human", at } } });
  const bodies: unknown[] = [];
  await page.route(RECORD, (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.fulfill(bodies.length === 1 ? failed : { json: saved });
  });
  const oneLiner = page.getByLabel(say("onboarding.company.one_liner"), { exact: true });
  await oneLiner.fill(text);
  await page.getByRole("button", { name: say("ui.action.save") }).click();
  const form = page.locator("form", { has: oneLiner });
  await expect(form.getByRole("alert")).toContainText(say("platform.error.generic"));
  await axe(page);
  await retry(page).click();
  await expect(page.getByText(say("onboarding.company.saved"))).toBeVisible();
  await expect(form.getByRole("alert")).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const line = page.locator('[data-part="last-changed"]');
  await expect(line).toContainText(chosen("onboarding.company.last_changed", "other"));
});

test("the pages read: the progress while the worker reads, a failed read with a retry, then each web page linked in a new tab without the referrer, and none; axe passes on each", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const fetchedAt = new Date().toISOString();
  const pages = [
    { url: SITE, title: "Corvid", status: "fetched", fetchedAt },
    { url: `${SITE}about`, title: "", status: "truncated", fetchedAt },
    { url: "ftp://corvid.test/files", title: "Files", status: "fetched", fetchedAt },
  ];
  const polled = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(RECORD, async (route) => {
    reads += 1;
    if (reads === 1) {
      return route.fulfill({ json: knowledge({ sourceUrl: SITE, fetchStatus: "fetching" }) });
    }
    if (reads > 2) {
      const json = knowledge({ sourceUrl: SITE, fetchStatus: "drafted", fetchedAt, pages });
      return route.fulfill({ json });
    }
    await polled.promise;
    await route.fulfill(failed);
  });
  await page.goto(`/w/${WORKSPACE}/company`);
  await expect(fetchPart(page).getByRole("status")).toHaveText(say("onboarding.company.fetching"));
  await axe(page);
  polled.resolve(); // the first poll, two seconds on, fails: no other poll until the retry
  await expect(fetchPart(page).getByRole("alert")).toContainText(say("platform.error.generic"));
  await expect(fetchPart(page)).toContainText(say("onboarding.company.error"));
  await axe(page);
  await retry(page).click();
  const read = fetchPart(page).getByRole("region", { name: /^3\D/ });
  await expect(read.getByRole("listitem")).toHaveText(["Corvid", /about/, "Files"]);
  const links = read.getByRole("link");
  await expect(links).toHaveCount(2);
  for (const [at, href] of [SITE, `${SITE}about`].entries()) {
    await expect(links.nth(at)).toHaveAttribute("href", href);
    await expect(links.nth(at)).toHaveAttribute("target", "_blank");
    await expect(links.nth(at)).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(read.getByRole("listitem").nth(1)).toContainText(
    say("onboarding.company.page_truncated"),
  );
  expect(reads).toBe(3);

  await page.unroute(RECORD);
  const none = knowledge({ sourceUrl: SITE, fetchStatus: "drafted", fetchedAt });
  await page.route(RECORD, (route) => route.fulfill({ json: none }));
  await page.reload();
  await expect(fetchPart(page).getByText(say("onboarding.company.pages_empty"))).toBeVisible();
  await axe(page);
});

test("a run reading for more than ten minutes is stuck: the screen says so, stops asking, and Draft is enabled; axe passes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const updatedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  let reads = 0;
  await page.route(RECORD, (route) => {
    reads += 1;
    const json = knowledge({ sourceUrl: SITE, fetchStatus: "fetching", updatedAt });
    return route.fulfill({ json });
  });
  await page.goto(`/w/${WORKSPACE}/company`);
  await expect(fetchPart(page).getByRole("status")).toHaveText(say("onboarding.company.stuck"));
  await expect(page.getByRole("button", { name: say("onboarding.company.draft") })).toBeEnabled();
  await axe(page);
  await page.waitForTimeout(5_000); // two and a half polls: none comes
  expect(reads).toBe(1);
});

test("a second Draft with a pending draft asks first: Cancel keeps the draft and sends nothing; the confirmation starts the Draft, which the api fails once, and its retry sends the same key; axe passes with the dialog open", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  let current = knowledge({ sourceUrl: SITE, fetchStatus: "drafted", pendingDraft: DRAFT });
  await page.route(RECORD, (route) => route.fulfill({ json: current }));
  const keys: (string | undefined)[] = [];
  await page.route(`${RECORD}/draft`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) return route.fulfill(failed);
    current = knowledge({ sourceUrl: SITE, fetchStatus: "fetching" });
    return route.fulfill({ status: 202, json: current });
  });
  await page.goto(`/w/${WORKSPACE}/company`);
  await expect(review(page)).toBeVisible();
  const draft = page.getByRole("button", { name: say("onboarding.company.draft") });
  await draft.click();
  const dialog = page.getByRole("dialog", {
    name: say("onboarding.company.draft_pending_confirm"),
  });
  await expect(dialog).toBeVisible();
  await axe(page);
  await dialog.getByRole("button", { name: say("ui.action.cancel") }).click();
  await expect(dialog).toBeHidden();
  await expect(review(page)).toBeVisible();
  expect(keys).toHaveLength(0);

  await draft.click();
  await dialog.getByRole("button", { name: say("onboarding.company.draft") }).click();
  await expect(fetchPart(page).getByRole("alert")).toContainText(say("platform.error.generic"));
  await expect(review(page)).toBeVisible();
  await retry(page).click();
  await expect(fetchPart(page).getByRole("status")).toHaveText(say("onboarding.company.fetching"));
  await expect(review(page)).toHaveCount(0);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("each source badge explains itself on hover and on keyboard focus; the last-changed line gives the time and the source; axe passes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const earlier = "2026-10-20T09:30:00.000Z";
  const later = "2026-10-21T16:45:00.000Z";
  const fieldSources = {
    oneLiner: { kind: "human", at: earlier },
    longDescription: { kind: "ai_draft", at: later, sourceUrl: `${SITE}about` },
  };
  const record = knowledge({
    sourceUrl: SITE,
    oneLiner: "Parcels for small shops, by bike",
    longDescription: "Corvid carries the parcels of small shops across town by bike.",
    fieldSources,
    version: 3,
  });
  await page.route(RECORD, (route) => route.fulfill({ json: record }));
  await page.goto(`/w/${WORKSPACE}/company`);
  const line = page.locator('[data-part="last-changed"]');
  await expect(line.locator("time")).toHaveAttribute("datetime", later);
  await expect(line).toContainText(chosen("onboarding.company.last_changed", "ai_draft"));

  const field = (name: string) => page.locator(`[data-field="${name}"]`);
  const hint = (name: string) => field(name).getByRole("tooltip");
  await expect(hint("longDescription")).toBeHidden();
  await field("longDescription")
    .getByText(say("onboarding.company.source.ai_draft"), { exact: true })
    .hover();
  const drafted = chosen("onboarding.company.source.hint", "ai_draft");
  await expect(hint("longDescription")).toHaveText(drafted);
  await page.mouse.move(0, 0);
  await expect(hint("longDescription")).toBeHidden();

  await page.getByLabel(say("onboarding.company.one_liner"), { exact: true }).focus();
  await page.keyboard.press("Tab");
  const badge = field("oneLiner").locator('[tabindex="0"]');
  await expect(badge).toBeFocused();
  const edited = chosen("onboarding.company.source.hint", "other");
  await expect(hint("oneLiner")).toHaveText(edited);
  await expect(badge).toHaveAccessibleDescription(edited);
  await axe(page);
});

test("the draft review: a draft with nothing in it says so, with Discard alone; an Accept is busy while held, fails with a retry, and the retry sends its key again; axe passes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const nothing = { ...DRAFT, fields: { ...DRAFT.fields, oneLiner: null, products: [] } };
  let current = knowledge({ sourceUrl: SITE, fetchStatus: "drafted", pendingDraft: nothing });
  await page.route(RECORD, (route) => route.fulfill({ json: current }));
  await page.goto(`/w/${WORKSPACE}/company`);
  await expect(review(page).getByText(say("onboarding.company.review.empty"))).toBeVisible();
  const accept = review(page).getByRole("button", { name: say("onboarding.company.accept") });
  await expect(accept).toHaveCount(0);
  await expect(
    review(page).getByRole("button", { name: say("onboarding.company.discard") }),
  ).toBeVisible();
  await axe(page);

  current = knowledge({ sourceUrl: SITE, fetchStatus: "drafted", pendingDraft: DRAFT });
  const at = new Date().toISOString();
  const accepted = knowledge({
    sourceUrl: SITE,
    fetchStatus: "drafted",
    oneLiner: DRAFT.fields.oneLiner.text,
    products: ["Same-day parcels"],
    fieldSources: {
      oneLiner: { kind: "ai_draft", at, sourceUrl: SITE },
      products: { kind: "ai_draft", at, sourceUrl: `${SITE}about` },
    },
    version: 2,
  });
  const keys: (string | undefined)[] = [];
  await page.route(`${RECORD}/draft/accept`, (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    return route.fulfill({ json: accepted });
  });
  const held = Promise.withResolvers<void>();
  const first = async (route: Route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    await held.promise;
    await route.fulfill(failed);
  };
  await page.route(`${RECORD}/draft/accept`, first, { times: 1 });
  await page.reload();
  await accept.click();
  await expect(accept).toHaveAttribute("aria-busy", "true");
  held.resolve();
  await expect(review(page).getByRole("alert")).toContainText(say("platform.error.generic"));
  await axe(page);
  await review(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  await expect(review(page)).toHaveCount(0);
  await expect(page.getByLabel(say("onboarding.company.one_liner"), { exact: true })).toHaveValue(
    DRAFT.fields.oneLiner.text,
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys[1]).toBe(keys[0]);
});
