// inbox's screen (beta-p5-040; core/modules/inbox/README.md "Screen"), on the leads and threads that
// the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_inbox, this
// spec's alone: the list newest first, each thread's lead, last message, who wrote last and replies
// to label, a row opening its thread; a thread's messages oldest first with their authors, the
// label's two buttons on a reply only, Positive then Not positive, and no reply box; "Load more"; the
// states of both screens, another workspace's thread not found; a phone's width. Every text from its
// key; axe.
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

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Message = {
  direction: "in" | "out";
  sentBy?: "campaign" | "user";
  body: string;
  sentAt: string;
  approvedAt?: string;
  label?: "positive" | "not_positive";
};
type Thread = { personId: string; messages: Message[] };
type Seeded = { id: string; messageIds: string[] };
type Label = { label: string; labeledBy: string; labeledAt: string } | null;
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

/** The workspace's threads, messages and labels replaced with these, a label the user's. */
async function seedThreads(page: Page, origin: string | undefined, threads: Thread[]) {
  const headers = { origin: origin ?? "" };
  const answer = await page.request.post(`${API}/e2e/inbox`, { data: { threads }, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { threads: Seeded[] }).threads;
}

/**
 * Three conversations: Ben's, the newest, his reply labeled positive and the account's answer typed
 * on LinkedIn after it; Ana's, her reply to the campaign waiting for a label; Cora's, the campaign's
 * message alone, the oldest.
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
      messages: [campaign("ana", 5), { direction: "in", body: REPLY, sentAt: at(2) }],
    },
    ben: {
      personId: persons.ben,
      messages: [
        campaign("ben", 6),
        { direction: "in", body: "Sounds good, tell me more.", sentAt: at(4), label: "positive" },
        { direction: "out", sentBy: "user", body: "Great: Tuesday at ten?", sentAt: at(1) },
      ],
    },
    cora: { personId: persons.cora, messages: [campaign("cora", 8)] },
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
const table = (page: Page) => page.getByRole("table", { name: t("inbox.list.caption") });
const rowOf = (page: Page, lead: Lead) =>
  table(page).getByRole("row", { name: new RegExp(`^${nameOf(lead)} `) });

test("the list: the threads newest first, each with its lead, its last message's time, who wrote last and its replies to label; a row opens its thread; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { persons, threads, ids } = await seed(page, baseURL);
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("inbox.list.title"));
  await expect(text(page, "inbox.list.description")).toBeVisible();
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

test("a thread: its messages oldest first, each with its author and time; Positive on a reply, then Not positive, kept; no label on an outbound message; no reply box, and the page writes nothing but the label; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
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
  await expect(button(group, "inbox.label.positive", false)).toBeVisible();
  await expect(button(group, "inbox.label.not_positive", false)).toBeVisible();
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(text(main, "inbox.thread.answer_on_linkedin")).toBeVisible();
  await axe(page);

  const messageId = ids.ana.messageIds[1] ?? "";
  await press(button(group, "inbox.label.positive"), button(group, "inbox.label.positive", true));
  await expect(button(group, "inbox.label.not_positive", false)).toBeVisible();
  const positive = await labelOf(page, ids.ana.id, messageId);
  expect(positive).toMatchObject({ label: "positive", labeledBy: me.user.id });
  await press(
    button(group, "inbox.label.not_positive"),
    button(group, "inbox.label.not_positive", true),
  );
  await expect(button(group, "inbox.label.positive", false)).toBeVisible();
  const changed = await labelOf(page, ids.ana.id, messageId);
  expect(changed).toMatchObject({ label: "not_positive", labeledBy: me.user.id });
  expect(Date.parse(changed?.labeledAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(positive?.labeledAt ?? ""),
  );
  await page.reload();
  await expect(button(group, "inbox.label.not_positive", true)).toBeVisible();
  await expect(button(group, "inbox.label.positive", false)).toBeVisible();
  await axe(page);

  // The account's answer typed on LinkedIn, and a reply labeled before the page opened.
  await page.goto(`${PATH}/${ids.ben.id}`);
  await expect(messages).toHaveCount(3);
  const labeled = messages.nth(1);
  await expect(labeled).toHaveAccessibleName(nameOf("ben"));
  await expect(button(labeled, "inbox.label.positive", true)).toBeVisible();
  const typed = messages.nth(2);
  await expect(typed).toHaveAccessibleName(t("inbox.thread.author.user"));
  await expect(text(typed, "inbox.thread.typed")).toBeVisible();
  await expect(typed.getByRole("button")).toHaveCount(0);
  await axe(page);

  const label = `/api/v1/workspaces/${WORKSPACE}/inbox/messages/${messageId}/label`;
  expect(sent.filter(({ method }) => method !== "GET")).toEqual([
    { method: "PUT", path: label, body: JSON.stringify({ label: "positive" }) },
    { method: "PUT", path: label, body: JSON.stringify({ label: "not_positive" }) },
  ]);
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
