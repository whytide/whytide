// inbox's reply draft on the thread screen (inbox-reply-draft; core/modules/inbox/README.md "The
// reply draft", "Screen"), on a lead and a thread that the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e) in wsp_e2e_reply_draft, this spec's alone: "Draft with AI" above
// the owner's reply box, the brief with the ui's counter of 2,000, Draft reply posting the brief
// once with an Idempotency-Key, then Drafting until the e2e module ends the draft (the e2e api runs
// no worker and calls no model); the draft ready, read-only, Use draft putting it in the reply box in
// place of its text, nothing sent; Draft again, then the draft failed in words, never its code, with
// Try again; a phone's width. Every text from its key; axe; a light screenshot.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import inbox from "../../../modules/inbox/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_reply_draft";
const PATH = `/w/${WORKSPACE}/inbox`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
const HOUR = 3_600_000;
/** The brief's most characters (core/modules/inbox/domain/reply-draft/constants.ts). */
const BRIEF_MAX = 2000;
const BRIEF = "Say yes and offer a short call on Tuesday or Thursday.";
const DRAFT = "Ana, yes: a short call on Tuesday or Thursday works. Would either suit you?";
const TYPED = "Thanks Ana,";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A change the draft's next read brings: it reads again every 2 seconds while drafting. */
const POLLED = 15_000;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Sent = { method: string; path: string; body: string | null; key: string | undefined };

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
  messages: nest({ ...inbox, ...platform, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** Ana's lead, and her thread on the signed-in user's account: the campaign's message, her reply. */
async function seed(page: Page, origin: string | undefined): Promise<string> {
  const headers = { origin: origin ?? "" };
  const lead = { slug: "e2e-reply-draft-ana", firstName: "Ana", lastName: "Lima" };
  const leads = await page.request.post(`${API}/e2e/leads`, {
    data: { leads: [{ ...lead, title: "Head of Data", source: "imported" }] },
    headers,
  });
  expect(leads.status(), await leads.text()).toBe(200);
  const [personId] = ((await leads.json()) as { personIds: string[] }).personIds;
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
  const messages = [
    {
      ...{ direction: "out", sentBy: "campaign", sentAt: at(5), approvedAt: at(6) },
      body: "Ana, how does your data team follow up on warm leads today?",
    },
    { direction: "in", body: "Good question. Can we talk next week?", sentAt: at(2) },
  ];
  const threads = await page.request.post(`${API}/e2e/inbox`, {
    data: { threads: [{ personId, messages }] },
    headers,
  });
  expect(threads.status(), await threads.text()).toBe(200);
  const [thread] = ((await threads.json()) as { threads: { id: string }[] }).threads;
  return thread?.id ?? "";
}

/** The thread's drafting draft ended as its run would end it, in the worker's stead. */
async function end(
  page: Page,
  origin: string | undefined,
  threadId: string,
  body: { status: "ready"; text: string } | { status: "failed"; errorCode: string },
) {
  const url = `${API}/e2e/inbox/reply-drafts/${threadId}`;
  const answer = await page.request.post(url, { data: body, headers: { origin: origin ?? "" } });
  expect(answer.status(), await answer.text()).toBe(200);
  expect(await answer.json()).toEqual({ settled: 1 });
}

/** Every write the page sends to the api: its method, path, body and Idempotency-Key. */
function writes(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && request.method() !== "GET") {
      const key = request.headers()["idempotency-key"];
      sent.push({ method: request.method(), path, body: request.postData(), key });
    }
  });
  return sent;
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

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const button = (scope: Locator | Page, key: string) =>
  scope.getByRole("button", { name: t(key), exact: true });
const text = (scope: Locator | Page, key: string, values?: Record<string, string | number>) =>
  scope.getByText(t(key, values), { exact: true });
const part = (page: Page) =>
  page.getByRole("main").getByRole("region", { name: t("inbox.draft.title") });

test("Draft with AI: the brief with its counter; Draft reply posts it once with an Idempotency-Key, Drafting, then the draft; Use draft puts it in the reply box in place of its text, nothing sent; Draft again, then a failure in words with Try again; axe", async ({
  page,
  signInAs,
  baseURL,
}, testInfo) => {
  test.slow(); // two waits for the draft's next read, every 2 seconds, and three axe runs
  await page.emulateMedia({ colorScheme: "light" });
  await signInAs();
  const threadId = await seed(page, baseURL);
  const sent = writes(page);
  await page.goto(`${PATH}/${threadId}`);
  const draft = part(page);
  const brief = draft.getByRole("textbox", { name: t("inbox.draft.brief") });
  await expect(brief).toBeEnabled();
  await expect(text(draft, "inbox.draft.brief_hint")).toBeVisible();
  const counter = (count: number) => text(draft, "ui.field.counter", { count, max: BRIEF_MAX });
  await expect(counter(0)).toBeVisible();
  // Typed again until the page, hydrated, counts it.
  await expect(async () => {
    await brief.fill(BRIEF);
    await expect(counter(BRIEF.length)).toBeVisible({ timeout: 1_000 });
  }).toPass();

  await button(draft, "inbox.draft.start").dblclick();
  await expect(text(draft, "inbox.draft.drafting")).toBeVisible();
  const path = `${API}/inbox/threads/${threadId}/reply-draft`;
  const body = JSON.stringify({ brief: BRIEF });
  expect(sent).toEqual([{ method: "POST", path, body, key: expect.stringMatching(UUID) }]);
  await axe(page);

  await end(page, baseURL, threadId, { status: "ready", text: DRAFT });
  await expect(draft.getByText(DRAFT, { exact: true })).toBeVisible({ timeout: POLLED });
  await expect(text(draft, "inbox.draft.ready")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("reply-draft-ready.png"), fullPage: true });
  const reply = page.getByRole("main").getByRole("textbox", { name: t("inbox.reply.label") });
  await reply.fill(TYPED);
  await button(draft, "inbox.draft.use").click();
  await expect(reply).toHaveValue(DRAFT);
  await expect(button(page.getByRole("main"), "inbox.reply.send")).toBeEnabled();
  await axe(page);
  expect(sent.map(({ path }) => path)).toEqual([path]);

  await button(draft, "inbox.draft.again").click();
  await expect(text(draft, "inbox.draft.drafting")).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.key).toMatch(UUID);
  expect(sent[1]?.key).not.toBe(sent[0]?.key);
  await end(page, baseURL, threadId, { status: "failed", errorCode: "gates_failed" });
  const failed = draft.getByRole("alert");
  await expect(text(failed, "inbox.draft.failure.checks")).toBeVisible({ timeout: POLLED });
  await expect(failed).not.toContainText("gates_failed");
  await expect(button(draft, "ui.action.retry")).toBeVisible();
  await expect(reply).toHaveValue(DRAFT);
  await axe(page);
  expect(sent.map(({ path }) => path)).toEqual([path, path]);
});

test("at a phone's width, 390×844, the thread with its ready draft fits: nothing scrolls sideways", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs();
  const threadId = await seed(page, baseURL);
  const posted = await page.request.post(`${API}/inbox/threads/${threadId}/reply-draft`, {
    data: {},
    headers: { origin: baseURL ?? "", "idempotency-key": crypto.randomUUID() },
  });
  expect(posted.status(), await posted.text()).toBe(202);
  await end(page, baseURL, threadId, { status: "ready", text: `${DRAFT} `.repeat(6).trim() });
  await page.goto(`${PATH}/${threadId}`);
  await expect(button(part(page), "inbox.draft.use")).toBeVisible();
  expect(await overflows(page)).toEqual([]);
});
