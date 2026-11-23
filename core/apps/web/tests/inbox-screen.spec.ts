// inbox's screen (beta-p5-040; core/modules/inbox/README.md "Screen"), on the leads and threads that
// the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_inbox, this
// spec's alone: the list newest first, the member's own threads only, a teammate's left out
// (gamma-p6-060), each thread's lead, last message, who wrote last and replies to label, a row
// opening its thread; a thread's messages oldest first with their authors, a reply's label
// (gamma-p4-055): the classifier's suggestion confirmed, then changed, opt_out asked first and moved
// away from, the person staying opted out, a light screenshot; the reply box (gamma-p4-061): a
// double press posting the text once, with one Idempotency-Key, the reply Sending, then Sent or Not
// sent with its reason in words as the e2e module settles it (the e2e api runs no worker); no box on
// the caller's own thread whose lead cannot be reached; a teammate's thread link not found;
// "Load more"; the states of both screens, the empty one of a member without a LinkedIn account,
// another workspace's thread not found; a phone's width. Every text from its key; axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import inbox from "../../../modules/inbox/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_inbox";
/** A workspace of the same user, which does not hold the threads (core/apps/api/tests/e2e-server.ts). */
const OTHER_WORKSPACE = "wsp_e2e_b";
const PATH = `/w/${WORKSPACE}/inbox`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A read of the list (core/modules/inbox/ui/inbox/constants.ts), and more threads than one read. */
const PAGE_SIZE = 20;
const MANY = 25;
/** Each lead's first and last name, by its thread's name in this spec. */
const LEADS = { ana: ["Ana", "Lima"], ben: ["Ben", "Okafor"], cora: ["Cora", "Diaz"] } as const;
type Lead = keyof typeof LEADS;
const PROFILE = { title: "Head of Data", companyName: "Blue Harbor Labs" };
const ROLE = "Head of Data at Blue Harbor Labs";
const REPLY = "Thanks, next week works. Can you send a few times?";
/** The owner's answers from the inbox, and the most LinkedIn takes (the reply state's textMax). */
const ANSWER = "Tuesday at ten or Thursday at three, whichever suits you.";
const SECOND = "Or Friday morning, if that is easier.";
const LINKEDIN_TEXT_MAX = 1900;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A change the thread's next read brings: it reads again every 3 seconds while a reply sends. */
const POLLED = 15_000;
/** A teammate: each e2e user is an Owner of the workspace (core/apps/api/tests/e2e-server.ts). */
const TEAMMATE = "e2e-usage@example.com";
/**
 * An Owner of the workspace with no LinkedIn account in it: linkedin-states.spec.ts connects theirs
 * in other workspaces only, and no spec seeds threads here as them.
 */
const NO_SENDER = "e2e-states@example.com";
/** The classifier's suggestion, under its 0.7: the owner confirms or changes it. */
const SUGGESTED = { label: "interested", confidence: 0.55, isSuggested: true } as const;

type Translate = (key: string, values?: Record<string, string | number>) => string;
/** campaigns' 7 labels, as the e2e module takes a reply's label and its classification. */
type ClassLabel =
  | "interested"
  | "not_now"
  | "not_interested"
  | "out_of_office"
  | "opt_out"
  | "bounce"
  | "other";
type Message = {
  direction: "in" | "out";
  sentBy?: "campaign" | "user";
  body: string;
  sentAt: string;
  approvedAt?: string;
  /** The signed-in user's label. */
  label?: ClassLabel;
  classification?: { label: ClassLabel; confidence: number; isSuggested: boolean };
};
type Thread = { personId: string; messages: Message[]; unreachable?: boolean };
type Seeded = { id: string; messageIds: string[] };
type Label = {
  label: string;
  classLabel: string | null;
  labeledBy: string;
  labeledAt: string;
} | null;
type Sent = { method: string; path: string; body: string | null };

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

const nameOf = (lead: Lead) => LEADS[lead].join(" ");
const LEAD_KEYS = Object.keys(LEADS) as Lead[];

/** The workspace's leads replaced with the three, each Head of Data at Blue Harbor Labs. */
async function seedLeads(page: Page, origin: string | undefined): Promise<Record<Lead, string>> {
  const leads = LEAD_KEYS.map((lead) => {
    const [firstName, lastName] = LEADS[lead];
    return { slug: `e2e-inbox-${lead}`, firstName, lastName, ...PROFILE, source: "imported" };
  });
  const headers = { origin: origin ?? "" };
  const answer = await page.request.post(`${API}/e2e/leads`, { data: { leads }, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  const { personIds } = (await answer.json()) as { personIds: string[] };
  return Object.fromEntries(
    LEAD_KEYS.map((lead, index) => [lead, personIds[index] ?? ""]),
  ) as Record<Lead, string>;
}

/**
 * The workspace's threads, messages and labels replaced with these, a label the user's, on the
 * user's own account; with `keep`, these added beside the workspace's others, a teammate's.
 */
async function seedThreads(
  page: Page,
  origin: string | undefined,
  threads: Thread[],
  keep = false,
) {
  const headers = { origin: origin ?? "" };
  const data = { threads, keep };
  const answer = await page.request.post(`${API}/e2e/inbox`, { data, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { threads: Seeded[] }).threads;
}

/**
 * Three conversations: Ben's, the newest, his reply labeled interested by the user and the account's
 * answer typed on LinkedIn after it; Ana's, her reply to the campaign waiting for a label, the
 * classifier only suggesting interested; Cora's, the campaign's message alone, the oldest, and no
 * member id of hers known, so no reply reaches her.
 */
async function seed(page: Page, origin: string | undefined) {
  const persons = await seedLeads(page, origin);
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const campaign = (lead: Lead, hoursAgo: number): Message => ({
    direction: "out",
    sentBy: "campaign",
    body: `${LEADS[lead][0]}, how does your data team follow up on warm leads today?`,
    sentAt: at(hoursAgo),
    approvedAt: at(hoursAgo + 1),
  });
  const threads: Record<Lead, Thread> = {
    ana: {
      personId: persons.ana,
      messages: [
        campaign("ana", 5),
        { direction: "in", body: REPLY, sentAt: at(2), classification: SUGGESTED },
      ],
    },
    ben: {
      personId: persons.ben,
      messages: [
        campaign("ben", 6),
        { direction: "in", body: "Sounds good, tell me more.", sentAt: at(4), label: "interested" },
        { direction: "out", sentBy: "user", body: "Great: Tuesday at ten?", sentAt: at(1) },
      ],
    },
    cora: { personId: persons.cora, messages: [campaign("cora", 8)], unreachable: true },
  };
  const [ana, ben, cora] = await seedThreads(page, origin, [
    threads.ana,
    threads.ben,
    threads.cora,
  ]);
  if (!ana || !ben || !cora) throw new Error("the e2e module seeded fewer threads");
  return { persons, threads, ids: { ana, ben, cora } };
}

/** Each request the page sends to the api, with its body. */
function recorded(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/"))
      sent.push({ method: request.method(), path, body: request.postData() });
  });
  return sent;
}

/** Each reply the page posts: its body and its Idempotency-Key. */
function replies(page: Page): { body: string | null; key: string | undefined }[] {
  const posted: { body: string | null; key: string | undefined }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/replies"))
      posted.push({ body: request.postData(), key: request.headers()["idempotency-key"] });
  });
  return posted;
}

/** The message id of the next reply the page posts, as the api answers it: 202, sending. */
async function answered(page: Page): Promise<string> {
  const response = await page.waitForResponse(
    (answer) =>
      answer.request().method() === "POST" && new URL(answer.url()).pathname.endsWith("/replies"),
  );
  expect(response.status(), await response.text()).toBe(202);
  return ((await response.json()) as { messageId: string }).messageId;
}

/** A sending reply settled as its send would settle it, in the worker's stead. */
async function settle(
  page: Page,
  origin: string | undefined,
  messageId: string,
  body: { status: "sent" | "refused" | "failed"; errorCode?: string },
) {
  const headers = { origin: origin ?? "" };
  const url = `${API}/e2e/inbox/replies/${messageId}`;
  const answer = await page.request.post(url, { data: body, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  expect(await answer.json()).toEqual({ settled: 1 });
}

/** A reply's label, as the api reads the thread. */
async function labelOf(page: Page, threadId: string, messageId: string): Promise<Label> {
  const read = await page.request.get(`${API}/inbox/threads/${threadId}`);
  expect(read.status(), await read.text()).toBe(200);
  const { messages } = (await read.json()) as { messages: { id: string; label: Label }[] };
  return messages.find(({ id }) => id === messageId)?.label ?? null;
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

/** A label chosen in the reply's menu: opened, pressed again until it opens, then the label's row. */
async function choose(group: Locator, key: string) {
  await press(button(group, "inbox.label.change"), button(group, key));
  await button(group, key).click();
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

const button = (scope: Locator | Page, key: string, pressed?: boolean) =>
  scope.getByRole("button", { name: t(key), exact: true, pressed });
const text = (scope: Locator | Page, key: string, values?: Record<string, string | number>) =>
  scope.getByText(t(key, values), { exact: true });
/** A reply's label as shown, its badges: the words seen, the closed menu's rows aside. */
const shown = (scope: Locator, key: string) => text(scope, key).filter({ visible: true });
const table = (page: Page) => page.getByRole("table", { name: t("inbox.list.caption") });
const rowOf = (page: Page, lead: Lead) =>
  table(page).getByRole("row", { name: new RegExp(`^${nameOf(lead)} `) });

test("the list: the member's own threads only, a teammate's left out, newest first, each with its lead, its last message's time, who wrote last and its replies to label; a row opens its thread; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { persons, threads, ids } = await seed(page, baseURL);
  // A teammate's conversation, the newest of all, on their own account: not in the user's list.
  await signInAs(TEAMMATE);
  const sentAt = new Date().toISOString();
  const reply = { direction: "in" as const, body: REPLY, sentAt };
  await seedThreads(page, baseURL, [{ personId: persons.ben, messages: [reply] }], true);
  await signInAs();
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.list.title"));
  await expect(text(page, "inbox.list.description")).toBeVisible();
  await expect(text(page, "inbox.list.scope")).toBeVisible();
  const names = ["ben", "ana", "cora"].map((lead) => new RegExp(`^${nameOf(lead as Lead)}`));
  await expect(table(page).getByRole("rowheader")).toHaveText(names);

  const ana = rowOf(page, "ana");
  await expect(ana).toContainText(ROLE);
  await expect(ana.locator("time")).toHaveAttribute(
    "datetime",
    threads.ana.messages[1]?.sentAt ?? "",
  );
  await expect(text(ana, "inbox.list.from.lead")).toBeVisible();
  await expect(text(ana, "inbox.list.to_label", { count: 1 })).toBeVisible();
  const ben = rowOf(page, "ben");
  await expect(ben.locator("time")).toHaveAttribute(
    "datetime",
    threads.ben.messages[2]?.sentAt ?? "",
  );
  await expect(text(ben, "inbox.list.from.account")).toBeVisible();
  const cora = rowOf(page, "cora");
  await expect(text(cora, "inbox.list.from.account")).toBeVisible();
  // Ben's reply is labeled and Cora has not replied: no reply waits in either.
  for (const row of [ben, cora]) await expect(row.getByRole("cell").last()).toHaveText("");
  await axe(page);

  const link = table(page).getByRole("link", { name: new RegExp(`^${nameOf("ana")}`) });
  await expect(link).toHaveAttribute("href", `${PATH}/${ids.ana.id}`);
  await link.click();
  await expect(page).toHaveURL(`${PATH}/${ids.ana.id}`);
  const heading = page.getByRole("heading", { level: 1 });
  const lead = heading.getByRole("link", { name: nameOf("ana"), exact: true });
  await expect(lead).toHaveAttribute("href", `/w/${WORKSPACE}/leads/${persons.ana}`);
  await expect(page.getByText(ROLE, { exact: true })).toBeVisible();
  await axe(page);
});

test("a thread: its messages oldest first, each with its author and time; a reply's suggested label confirmed in one click, changed, opt_out asked first, then moved away from, the person staying opted out; no label on an outbound message; the owner's reply box under them, and the page writes nothing but the labels; axe and a light screenshot", async ({
  page,
  signInAs,
  baseURL,
}, testInfo) => {
  await signInAs();
  const { threads, ids } = await seed(page, baseURL);
  const me = (await (await page.request.get("/api/v1/me")).json()) as { user: { id: string } };
  const sent = recorded(page);
  await page.goto(`${PATH}/${ids.ana.id}`);
  const main = page.getByRole("main");
  const messages = main
    .getByRole("list", { name: t("inbox.thread.messages") })
    .getByRole("article");
  await expect(messages).toHaveCount(2);
  const [first, second] = threads.ana.messages;
  const campaign = messages.nth(0);
  await expect(campaign).toHaveAccessibleName(t("inbox.thread.author.campaign"));
  await expect(campaign.locator(`time[datetime="${first?.sentAt}"]`)).toBeVisible();
  await expect(campaign.locator(`time[datetime="${first?.approvedAt}"]`)).toBeVisible();
  await expect(campaign.getByRole("button")).toHaveCount(0);
  const reply = messages.nth(1);
  await expect(reply).toHaveAccessibleName(nameOf("ana"));
  await expect(reply.locator(`time[datetime="${second?.sentAt}"]`)).toBeVisible();
  await expect(reply.getByText(REPLY, { exact: true })).toBeVisible();
  const group = reply.getByRole("group", { name: t("inbox.label.group") });
  const suggested = shown(group, "inbox.class.suggested");
  await expect(shown(group, "inbox.class.interested")).toBeVisible();
  await expect(suggested).toBeVisible();
  await expect(button(group, "inbox.label.change")).toBeVisible();
  await expect(main.getByRole("textbox", { name: t("inbox.reply.label") })).toBeEnabled();
  await axe(page);

  // Confirm takes the suggestion: "Suggested" and Confirm go, the label stays.
  const messageId = ids.ana.messageIds[1] ?? "";
  const confirm = button(group, "inbox.label.confirm");
  await expect(async () => {
    if (await confirm.isVisible()) await confirm.click({ timeout: 1_000 });
    await expect(suggested).toHaveCount(0, { timeout: 1_000 });
  }).toPass();
  await expect(confirm).toHaveCount(0);
  await expect(shown(group, "inbox.class.interested")).toBeVisible();
  const confirmed = await labelOf(page, ids.ana.id, messageId);
  const owner = { labeledBy: me.user.id };
  expect(confirmed).toMatchObject({ label: "positive", classLabel: "interested", ...owner });

  // Another label from the menu, the chosen one pressed in it.
  await press(button(group, "inbox.label.change"), button(group, "inbox.class.interested", true));
  await button(group, "inbox.class.not_now").click();
  await expect(shown(group, "inbox.class.not_now")).toBeVisible();
  await expect(shown(group, "inbox.class.interested")).toHaveCount(0);
  const changed = await labelOf(page, ids.ana.id, messageId);
  expect(changed).toMatchObject({ label: "not_positive", classLabel: "not_now", ...owner });

  // opt_out asks first: Cancel sends nothing, then the confirmation labels it.
  await choose(group, "inbox.class.opt_out");
  const dialog = page.getByRole("dialog", { name: t("inbox.class.opt_out") });
  await expect(dialog).toBeVisible();
  await expect(text(dialog, "inbox.label.opt_out_confirm")).toBeVisible();
  await axe(page);
  await button(dialog, "ui.action.cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(shown(group, "inbox.class.not_now")).toBeVisible();
  await choose(group, "inbox.class.opt_out");
  await button(dialog, "inbox.label.confirm").click();
  await expect(shown(group, "inbox.class.opt_out")).toBeVisible();
  const optedOut = await labelOf(page, ids.ana.id, messageId);
  expect(optedOut).toMatchObject({ label: "not_positive", classLabel: "opt_out", ...owner });

  // Away from opt_out: the person stays opted out, and the screen says so.
  await choose(group, "inbox.class.interested");
  await expect(shown(group, "inbox.class.interested")).toBeVisible();
  await expect(text(reply, "inbox.label.opt_out_stays")).toBeVisible();
  const away = await labelOf(page, ids.ana.id, messageId);
  expect(away).toMatchObject({ label: "positive", classLabel: "interested", ...owner });
  await axe(page);
  await page.screenshot({ path: testInfo.outputPath("inbox-thread-label.png"), fullPage: true });
  await page.reload();
  await expect(shown(group, "inbox.class.interested")).toBeVisible();
  await expect(suggested).toHaveCount(0);

  // The account's answer typed on LinkedIn, and a reply labeled before the page opened.
  await page.goto(`${PATH}/${ids.ben.id}`);
  await expect(messages).toHaveCount(3);
  const labeled = messages.nth(1);
  await expect(labeled).toHaveAccessibleName(nameOf("ben"));
  await expect(shown(labeled, "inbox.class.interested")).toBeVisible();
  await expect(shown(labeled, "inbox.class.suggested")).toHaveCount(0);
  await expect(button(labeled, "inbox.label.confirm")).toHaveCount(0);
  const typed = messages.nth(2);
  await expect(typed).toHaveAccessibleName(t("inbox.thread.author.user"));
  await expect(text(typed, "inbox.thread.typed")).toBeVisible();
  await expect(typed.getByRole("button")).toHaveCount(0);
  await axe(page);

  const label = `/api/v1/workspaces/${WORKSPACE}/inbox/messages/${messageId}/label`;
  const put = (value: ClassLabel) => ({
    method: "PUT",
    path: label,
    body: JSON.stringify({ label: value }),
  });
  expect(sent.filter(({ method }) => method !== "GET")).toEqual([
    put("interested"),
    put("not_now"),
    put("opt_out"),
    put("interested"),
  ]);
});

test("a reply from the thread: the owner's box with the channel's counter, Send disabled while empty; a double press posts the text once, with one Idempotency-Key; the reply Sending, then Sent; another one Not sent, its reason in words; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // two waits for the thread's next read, every 3 seconds, and four axe runs
  await signInAs();
  const { ids } = await seed(page, baseURL);
  const sent = recorded(page);
  const posts = replies(page);
  await page.goto(`${PATH}/${ids.ana.id}`);
  const main = page.getByRole("main");
  const box = main.getByRole("textbox", { name: t("inbox.reply.label") });
  const counter = (count: number) =>
    text(main, "ui.field.counter", { count, max: LINKEDIN_TEXT_MAX });
  await expect(box).toBeEnabled();
  await expect(counter(0)).toBeVisible();
  const send = button(main, "inbox.reply.send");
  await expect(send).toBeDisabled();
  // Typed again until the page, hydrated, counts it.
  await expect(async () => {
    await box.fill(ANSWER);
    await expect(counter(ANSWER.length)).toBeVisible({ timeout: 1_000 });
  }).toPass();

  const messages = main
    .getByRole("list", { name: t("inbox.thread.messages") })
    .getByRole("article");
  const first = answered(page);
  await send.dblclick();
  const reply = messages.nth(2);
  await expect(text(reply, "inbox.reply.status.sending")).toBeVisible();
  await expect(reply).toHaveAccessibleName(t("inbox.thread.author.user"));
  await expect(reply.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(text(reply, "inbox.thread.typed")).toHaveCount(0);
  await expect(box).toHaveValue("");
  await expect(send).toBeDisabled();
  await expect(messages).toHaveCount(3);
  // The double press: one request, with one key.
  expect(posts).toEqual([{ body: JSON.stringify({ text: ANSWER }), key: expect.any(String) }]);
  expect(posts[0]?.key).toMatch(UUID);
  await axe(page);

  await settle(page, baseURL, await first, { status: "sent" });
  await expect(text(reply, "inbox.reply.status.sent")).toBeVisible({ timeout: POLLED });
  await expect(text(reply, "inbox.reply.status.sending")).toHaveCount(0);
  await axe(page);

  // Another reply, refused outside the account's working hours: not kept for later.
  await box.fill(SECOND);
  const second = answered(page);
  await send.click();
  const refused = messages.nth(3);
  await expect(text(refused, "inbox.reply.status.sending")).toBeVisible();
  const code = "outside_working_hours";
  await settle(page, baseURL, await second, { status: "refused", errorCode: code });
  await expect(text(refused, "inbox.reply.status.not_sent")).toBeVisible({ timeout: POLLED });
  await expect(text(refused, "inbox.reply.reason.outside_working_hours")).toBeVisible();
  await expect(refused).not.toContainText(code);
  await expect(text(reply, "inbox.reply.status.sent")).toBeVisible();
  await axe(page);

  const path = `${API}/inbox/threads/${ids.ana.id}/replies`;
  expect(sent.filter(({ method }) => method !== "GET")).toEqual([
    { method: "POST", path, body: JSON.stringify({ text: ANSWER }) },
    { method: "POST", path, body: JSON.stringify({ text: SECOND }) },
  ]);
  expect(posts[1]?.key).toMatch(UUID);
  expect(posts[1]?.key).not.toBe(posts[0]?.key);
});

test("no reply box on the caller's own thread whose lead cannot be reached, a line saying why; a teammate's thread link shows the not-found state, its api read 404; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { persons, ids } = await seed(page, baseURL);
  await page.goto(`${PATH}/${ids.cora.id}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("article")).toHaveCount(1);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(button(main, "inbox.reply.send")).toHaveCount(0);
  await expect(text(main, "inbox.errors.reply_channel_unavailable")).toBeVisible();
  await axe(page);

  // A thread on the teammate's account, connected, its lead reachable: theirs alone to read.
  await signInAs(TEAMMATE);
  const sentAt = new Date().toISOString();
  const reply = { direction: "in" as const, body: REPLY, sentAt, classification: SUGGESTED };
  const seeded = await seedThreads(
    page,
    baseURL,
    [{ personId: persons.ben, messages: [reply] }],
    true,
  );
  const theirs = seeded[0]?.id ?? "";
  expect((await page.request.get(`${API}/inbox/threads/${theirs}`)).status()).toBe(200);
  await signInAs();
  const read = await page.request.get(`${API}/inbox/threads/${theirs}`);
  expect([read.status(), await read.json()]).toEqual([404, { code: "thread_not_found" }]);
  await page.goto(`${PATH}/${theirs}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.thread.not_found"));
  await expect(text(main, "inbox.errors.thread_not_found")).toBeVisible();
  await expect(main.getByRole("link", { name: t("inbox.thread.back") })).toHaveAttribute(
    "href",
    PATH,
  );
  await expect(main.getByText(REPLY, { exact: true })).toHaveCount(0);
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await axe(page);
});

test("Load more adds the next page's threads under the first's, newest first, then goes", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const persons = await seedLeads(page, baseURL);
  const now = Date.now();
  const threads = Array.from({ length: MANY }, (_, index) => ({
    personId: persons.ana,
    messages: [
      {
        direction: "in" as const,
        body: REPLY,
        sentAt: new Date(now - index * MINUTE).toISOString(),
      },
    ],
  }));
  await seedThreads(page, baseURL, threads);
  await page.goto(PATH);
  const rows = table(page).getByRole("rowheader");
  await expect(rows).toHaveCount(PAGE_SIZE);
  const more = button(page, "inbox.list.load_more");
  await press(more, rows.nth(MANY - 1));
  await expect(rows).toHaveCount(MANY);
  await expect(more).toHaveCount(0);
  const times = await table(page)
    .locator("time")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime")));
  expect(times).toEqual(threads.map(({ messages }) => messages[0]?.sentAt));
});

test("the list's states: loading while its read is held, then empty; a failed read in words, with Try again; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seedThreads(page, baseURL, []);
  const path = "/inbox/threads";
  await cookie(context, baseURL, "e2e_hold", path);
  await page.goto(PATH, { waitUntil: "commit" });
  const main = page.getByRole("main");
  await expect(main.getByRole("status").filter({ hasText: t("ui.state.loading") })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.list.title"));
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const empty = text(page, "inbox.list.empty");
  await expect(empty).toBeVisible();
  await axe(page);

  await cookie(context, baseURL, "e2e_fail", path);
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(t("inbox.list.error"));
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(t("platform.error.generic"));
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await press(button(alert, "ui.action.retry"), empty);
  await expect(alert).toHaveCount(0);
});

test("the empty list of a member without a LinkedIn account of their own says to connect one, with its link; a teammate's threads stay out of it; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL);
  await signInAs(NO_SENDER);
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.list.title"));
  await expect(text(page, "inbox.empty.no_sender")).toBeVisible();
  await expect(text(page, "inbox.list.empty")).toHaveCount(0);
  await expect(page.getByRole("link", { name: t("inbox.empty.connect") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/linkedin`,
  );
  await expect(table(page).getByRole("rowheader")).toHaveCount(0);
  await axe(page);
});

test("the thread's states: loading while its read is held, then a thread without a message; a failed read in words, with Try again; another workspace's thread not found; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const persons = await seedLeads(page, baseURL);
  const [thread] = await seedThreads(page, baseURL, [{ personId: persons.cora, messages: [] }]);
  const id = thread?.id ?? "";
  const path = `/inbox/threads/${id}`;
  await cookie(context, baseURL, "e2e_hold", path);
  await page.goto(`${PATH}/${id}`, { waitUntil: "commit" });
  const main = page.getByRole("main");
  await expect(main.getByRole("status").filter({ hasText: t("ui.state.loading") })).toBeVisible();
  await expect(main.getByRole("link", { name: t("inbox.thread.back") })).toHaveAttribute(
    "href",
    PATH,
  );
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const empty = text(page, "inbox.thread.empty");
  await expect(empty).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(nameOf("cora"));
  await axe(page);

  await cookie(context, baseURL, "e2e_fail", path);
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(t("inbox.thread.error"));
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(t("platform.error.generic"));
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await press(button(alert, "ui.action.retry"), empty);
  await expect(alert).toHaveCount(0);

  await page.goto(`/w/${OTHER_WORKSPACE}/inbox/${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.thread.not_found"));
  await expect(text(main, "inbox.errors.thread_not_found")).toBeVisible();
  await expect(main.getByRole("link", { name: t("inbox.thread.back") })).toHaveAttribute(
    "href",
    `/w/${OTHER_WORKSPACE}/inbox`,
  );
  await axe(page);
});

test("at a phone's width, 390×844, the list and a thread fit: nothing scrolls sideways", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs();
  const { ids } = await seed(page, baseURL);
  await page.goto(PATH);
  await expect(table(page).getByRole("rowheader")).toHaveCount(3);
  expect(await overflows(page)).toEqual([]);
  await page.goto(`${PATH}/${ids.ben.id}`);
  await expect(page.getByRole("main").getByRole("article")).toHaveCount(3);
  expect(await overflows(page)).toEqual([]);
});
