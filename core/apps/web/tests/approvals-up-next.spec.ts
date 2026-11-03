// approvals' "Up next" (beta-p3-040; core/modules/approvals/README.md "Screen"), on the leads,
// drafts and items that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in
// wsp_e2e_up_next, this spec's alone, sent from the signed-in user's account in New York while the
// browser is in Tokyo. The e2e api runs no worker: a drafting row's draft is written and attached by
// the e2e module, and the queue's next read shows it. The queue grouped and flagged, its times in the
// sender's zone; Approve and Skip with the counters, and the requests the page sends; Edit and the
// gates' refusals, a failed draft written by hand, an empty note; a drafting row; a member who does
// not own the account; Show facts; the states; a phone's width. Every text from its key; axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import approvals from "../../../modules/approvals/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_up_next";
const PATH = `/w/${WORKSPACE}/up-next`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
/** The sender account's zone; the browser's is another, half a day ahead. */
const ZONE = "America/New_York";
const BROWSER_ZONE = "Asia/Tokyo";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The screen's formats (core/modules/approvals/ui/up-next/constants.ts): a row's time, a group's. */
const TIME = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;
const GROUP = {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  timeZoneName: "short",
} as const;
/** Each row's lead, first and last name and tier, by the row's name in this spec. */
const LEADS = {
  ready: ["Ana", "Ready", "hot"],
  flagged: ["Ben", "Flagged", "warm"],
  failed: ["Cora", "Failed", "cool"],
  drafting: ["Dan", "Drafting", "hot"],
  connect: ["Eve", "Connect", "warm"],
  yesterday: ["Finn", "Yesterday", "cool"],
  waited: ["Gus", "Waited", "hot"],
} as const;
type Row = keyof typeof LEADS;
const ROWS = Object.keys(LEADS) as Row[];
const WHY = { criterion: "title_function", quote: "Head of Data", met: 4, total: 5 };
const GLOBEX = { gate: "grounding", entity: "Globex" };
const LATER = "Dan, one more question: who at Blue Harbor Labs answers warm leads this month?";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.use({ timezoneId: BROWSER_ZONE });

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Dossier = { dossierHash: string; facts: { id: string; sourceRef: string }[] };
type Seeded = { id: string; draftId: string; personId: string; scheduledFor: string };
type Sent = { method: string; path: string; key?: string; body: string | null };

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
  messages: nest({ ...approvals, ...qualification, ...platform, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

const nameOf = (row: Row) => `${LEADS[row][0]} ${LEADS[row][1]}`;
const textOf = (row: Row) =>
  `${LEADS[row][0]}, how does the data team at Blue Harbor Labs follow up on warm leads today?`;
const iso = (at: number) => new Date(at).toISOString();

/** A ready draft on the lead's first name, title and company, as its dossier numbers them. */
function readyDraft(row: Row, dossier: Dossier) {
  const fact = (column: string) => dossier.facts.find((f) => f.sourceRef.endsWith(`/${column}`));
  const factIds = ["first_name", "title", "company_name"].map((column) => fact(column)?.id);
  const plan = { angle: "pain_point", factIds, cta: "question" };
  return { status: "ready", plan, text: textOf(row), dossierHash: dossier.dossierHash };
}

/** Each row's step, due time and draft; `hour` starts the hour the first two share, in any zone. */
function itemOf(row: Row, personId: string, dossier: Dossier, hour: number) {
  const ready = readyDraft(row, dossier);
  const now = Date.now();
  const at = (offset: number) => ({ personId, scheduledFor: iso(hour + offset) });
  switch (row) {
    case "ready":
      return { ...at(10 * MINUTE), stepKey: "message_1", draft: ready };
    case "flagged": {
      const text = "Ben, Globex follows up on warm leads within the hour. Does your team?";
      const gates = [{ gate: "grounding", issues: [GLOBEX] }];
      const draft = { ...ready, status: "flagged", text, gates, flagReasons: [GLOBEX] };
      return { ...at(20 * MINUTE), stepKey: "follow_up_1", draft };
    }
    case "failed": {
      const draft = { status: "failed", gates: [], flagReasons: [{ code: "ai_failed" }] };
      return { ...at(HOUR + 10 * MINUTE), stepKey: "message_1", draft };
    }
    case "drafting":
      return {
        ...at(2 * HOUR + 10 * MINUTE),
        stepKey: "follow_up_2",
        draft: { status: "drafting" },
      };
    case "connect":
      return { ...at(3 * HOUR + 10 * MINUTE), stepKey: "connect", draft: { text: "" } };
    case "yesterday": {
      const times = { scheduledFor: iso(now - 26 * HOUR), createdAt: iso(now - 27 * HOUR) };
      return { personId, ...times, stepKey: "message_1", draft: ready };
    }
    case "waited": {
      const times = { scheduledFor: iso(now - 49 * HOUR), createdAt: iso(now - 73 * HOUR) };
      return { personId, ...times, stepKey: "message_1", draft: ready };
    }
  }
}

/** The workspace's leads and the rows' items, replaced: each row's item, draft and due time. */
async function seed(page: Page, origin: string | undefined, rows: readonly Row[] = ROWS) {
  const headers = { origin: origin ?? "" };
  const leads = rows.map((row) => {
    const [firstName, lastName, tier] = LEADS[row];
    const why = [{ key: "qualification.why.fit", params: WHY }];
    const decision = { status: "qualified", fitScore: 80, confidence: "high", tier, why };
    const profile = { firstName, lastName, title: "Head of Data", companyName: "Blue Harbor Labs" };
    return { slug: `e2e-up-next-${row}`, ...profile, source: "imported", decision };
  });
  const answer = await page.request.post(`${API}/e2e/leads`, { data: { leads }, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  const { personIds } = (await answer.json()) as { personIds: string[] };
  const hour = Math.floor((Date.now() + 3 * HOUR) / HOUR) * HOUR;
  const items: ReturnType<typeof itemOf>[] = [];
  for (const [index, row] of rows.entries()) {
    const personId = personIds[index] ?? "";
    const read = await page.request.get(`${API}/messaging/leads/${personId}/dossier`);
    expect(read.status(), await read.text()).toBe(200);
    items.push(itemOf(row, personId, (await read.json()) as Dossier, hour));
  }
  const data = { timeZone: ZONE, items };
  const seeded = await page.request.post(`${API}/e2e/up-next`, { data, headers });
  expect(seeded.status(), await seeded.text()).toBe(200);
  const ids = ((await seeded.json()) as { items: { id: string; draftId: string }[] }).items;
  const entries = rows.map((row, index) => [row, { ...ids[index], ...items[index] }]);
  return Object.fromEntries(entries) as Record<Row, Seeded>;
}

/** The most characters the item's text takes, as the api's list answers it. */
async function maxOf(page: Page, id: string): Promise<number> {
  const read = await page.request.get(`${API}/approvals/items`);
  type Items = { items: { id: string; draft: { maxCharacters: number } | null }[] };
  const { items } = (await read.json()) as Items;
  return items.find((item) => item.id === id)?.draft?.maxCharacters ?? 0;
}

/** A time as the browser words it in a zone, with one of the screen's formats. */
const worded = (page: Page, at: string, format: Intl.DateTimeFormatOptions, timeZone: string) =>
  page.evaluate(
    ({ at, format, timeZone }) =>
      new Intl.DateTimeFormat(document.documentElement.lang || "en", {
        ...format,
        timeZone,
      }).format(new Date(at)),
    { at, format, timeZone },
  );

/** Every request the page sends to the api, with its key and body. */
function recorded(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return;
    const key = request.headers()["idempotency-key"];
    sent.push({ method: request.method(), path, key, body: request.postData() });
  });
  return sent;
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

const rowOf = (page: Page, row: Row) => page.getByRole("article", { name: nameOf(row) });
const button = (scope: Locator | Page, key: string) =>
  scope.getByRole("button", { name: t(key), exact: true });
const text = (scope: Locator | Page, key: string, values?: Record<string, string | number>) =>
  scope.getByText(t(key, values), { exact: true });
const counted = (page: Page, key: "to_approve" | "decided_today", count: number) =>
  text(page, `approvals.up_next.count.${key}`, { count });

test("Overdue first, then by the hour in the sender's zone, never the browser's; each row's lead, step, time and flags; the counters; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const seeded = await seed(page, baseURL);
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("approvals.up_next.title"));
  await expect(text(page, "approvals.up_next.nothing_sent")).toBeVisible();
  await expect(counted(page, "to_approve", 7)).toBeVisible();
  await expect(counted(page, "decided_today", 0)).toBeVisible();

  const hours = ["ready", "failed", "drafting", "connect"] as const;
  const headings = [t("approvals.up_next.group.overdue")];
  for (const row of hours) headings.push(await worded(page, seeded[row].scheduledFor, GROUP, ZONE));
  await expect(page.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(headings);
  const overdue = page.getByRole("region", { name: t("approvals.up_next.group.overdue") });
  await expect(overdue.getByRole("article")).toHaveText([/Gus Waited/, /Finn Yesterday/]);
  const first = page.getByRole("region", { name: headings[1] ?? "" });
  await expect(first.getByRole("article")).toHaveText([/Ana Ready/, /Ben Flagged/]);

  const ready = rowOf(page, "ready");
  const link = ready.getByRole("link", { name: nameOf("ready") });
  await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/leads/${seeded.ready.personId}`);
  await expect(ready.getByText("Head of Data at Blue Harbor Labs", { exact: true })).toBeVisible();
  await expect(text(ready, "ui.tier.hot")).toBeVisible();
  await expect(text(ready, "qualification.why.fit", WHY)).toBeVisible();
  await expect(text(ready, "approvals.up_next.step.message_1")).toBeVisible();
  const due = await worded(page, seeded.ready.scheduledFor, TIME, ZONE);
  expect(due).not.toBe(await worded(page, seeded.ready.scheduledFor, TIME, BROWSER_ZONE));
  await expect(ready.locator("time")).toHaveText(due);
  await expect(ready.locator("time")).toHaveAttribute("datetime", seeded.ready.scheduledFor);
  await expect(ready.getByText(textOf("ready"), { exact: true })).toBeVisible();
  const max = await maxOf(page, seeded.ready.id);
  const count = { count: textOf("ready").length, max };
  await expect(text(ready, "approvals.up_next.counter", count)).toBeVisible();
  await expect(text(ready, "approvals.up_next.flag.stale")).toHaveCount(0);

  const yesterday = rowOf(page, "yesterday");
  await expect(text(yesterday, "approvals.up_next.flag.stale")).toBeVisible();
  await expect(text(yesterday, "approvals.up_next.flag.needs_attention")).toHaveCount(0);
  const waited = rowOf(page, "waited");
  await expect(text(waited, "approvals.up_next.flag.stale")).toBeVisible();
  await expect(text(waited, "approvals.up_next.flag.needs_attention")).toBeVisible();
  const flagged = rowOf(page, "flagged");
  await expect(text(flagged, "approvals.up_next.step.follow_up_1")).toBeVisible();
  await expect(text(flagged, "approvals.up_next.flag.gate_warning")).toBeVisible();
  await expect(
    text(flagged, "approvals.up_next.gate.grounding", { entity: "Globex" }),
  ).toBeVisible();
  const failed = rowOf(page, "failed");
  await expect(text(failed, "approvals.up_next.flag.failed")).toBeVisible();
  await expect(failed.getByRole("textbox", { name: t("approvals.up_next.text") })).toHaveValue("");
  await expect(text(failed, "approvals.up_next.hint.failed")).toBeVisible();
  const drafting = rowOf(page, "drafting");
  await expect(text(drafting, "approvals.up_next.step.follow_up_2")).toBeVisible();
  await expect(text(drafting, "approvals.up_next.flag.drafting")).toBeVisible();
  await expect(drafting.getByRole("status")).toHaveText(t("approvals.up_next.drafting"));
  await expect(button(drafting, "approvals.up_next.action.approve")).toHaveCount(0);
  const connect = rowOf(page, "connect");
  await expect(text(connect, "approvals.up_next.step.connect")).toBeVisible();
  await expect(text(connect, "approvals.up_next.empty_note")).toBeVisible();
  await axe(page);
});

test("Approve moves the row out and counts it decided today; Skip asks first, a connection request's dialog saying its sequence ends; Show facts lists the draft's facts with their sources; the page reads approvals' routes and the dossier only, a key per press; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL);
  const sent = recorded(page);
  await page.goto(PATH);
  const approved = text(page, "approvals.up_next.toast.approved", { name: nameOf("ready") });
  await press(button(rowOf(page, "ready"), "approvals.up_next.action.approve"), approved);
  await expect(rowOf(page, "ready")).toHaveCount(0);
  await expect(counted(page, "decided_today", 1)).toBeVisible();
  await expect(counted(page, "to_approve", 6)).toBeVisible();

  const dialog = page.getByRole("dialog", { name: t("approvals.up_next.skip.title") });
  const connect = rowOf(page, "connect");
  await button(connect, "approvals.up_next.action.skip").click();
  const ends = t("approvals.up_next.skip.body_connect", { name: nameOf("connect") });
  await expect(dialog).toContainText(ends);
  await axe(page);
  await button(dialog, "ui.action.cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(connect).toBeVisible();
  await button(connect, "approvals.up_next.action.skip").click();
  await button(dialog, "approvals.up_next.skip.confirm").click();
  await expect(connect).toHaveCount(0);
  await expect(counted(page, "decided_today", 2)).toBeVisible();
  const yesterday = rowOf(page, "yesterday");
  await button(yesterday, "approvals.up_next.action.skip").click();
  const goesOn = t("approvals.up_next.skip.body_message", { name: nameOf("yesterday") });
  await expect(dialog).toContainText(goesOn);
  await button(dialog, "approvals.up_next.skip.confirm").click();
  await expect(yesterday).toHaveCount(0);
  await expect(counted(page, "decided_today", 3)).toBeVisible();
  await expect(counted(page, "to_approve", 4)).toBeVisible();

  const waited = rowOf(page, "waited");
  await button(waited, "approvals.up_next.facts.show").click();
  const facts = waited.getByRole("region", { name: t("approvals.up_next.facts.title") });
  const source = (column: string) => t("approvals.up_next.source.persons", { column });
  await expect(facts.getByRole("listitem")).toHaveText([
    `Gus ${source("first_name")}`,
    `Head of Data ${source("title")}`,
    `Blue Harbor Labs ${source("company_name")}`,
  ]);
  await expect(waited).not.toContainText("persons/");
  const hide = button(waited, "approvals.up_next.facts.hide");
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await axe(page);

  const reads = [
    /\/approvals\/items$/,
    /\/messaging\/leads\/[^/]+\/dossier$/,
    // The shell's header, on any screen of the workspace.
    /\/credits\/balance$/,
  ];
  const presses = /\/approvals\/items\/[^/]+\/(?:approve|skip)$/;
  const allowed = ({ method, path }: Sent) =>
    path.startsWith(`${API}/`) &&
    (method === "GET" ? reads.some((read) => read.test(path)) : presses.test(path));
  expect(sent.filter((request) => !allowed(request))).toEqual([]);
  const posts = sent.filter(({ method }) => method === "POST");
  expect(posts.map(({ path }) => path.split("/").at(-1))).toEqual(["approve", "skip", "skip"]);
  expect(posts.every(({ key }) => key !== undefined && UUID.test(key))).toBe(true);
  expect(new Set(posts.map(({ key }) => key)).size).toBe(3);
  // A bare Approve sends the draft as it is: the body is required, and empty.
  expect(posts[0]?.body).toBe("{}");
});

test("Edit shows the text's counter; a red line or a colleague is refused with the gates' reasons, the typed text kept; a failed draft written by hand is approved; a connection request is approved with an empty note; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const seeded = await seed(page, baseURL, ["ready", "failed", "connect"]);
  const max = await maxOf(page, seeded.ready.id);
  const counter = (said: string) => ({ count: said.trim().length, max });
  await page.goto(PATH);
  const ready = rowOf(page, "ready");
  const box = ready.getByRole("textbox", { name: t("approvals.up_next.text") });
  const approve = button(ready, "approvals.up_next.action.approve");
  await press(button(ready, "approvals.up_next.action.edit"), box);
  await expect(box).toHaveValue(textOf("ready"));
  await expect(text(ready, "approvals.up_next.counter", counter(textOf("ready")))).toBeVisible();

  const red = `${textOf("ready")} As we discussed, would a call help?`;
  await box.fill(red);
  await expect(text(ready, "approvals.up_next.counter", counter(red))).toBeVisible();
  await approve.click();
  await expect(text(ready, "approvals.up_next.refused")).toBeVisible();
  const line = { phrase: "as we discussed" };
  await expect(text(ready, "approvals.up_next.gate.red_lines", line)).toBeVisible();
  await expect(box).toHaveValue(red);
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await axe(page);
  const colleague = `${textOf("ready")} Your colleague liked the idea.`;
  await box.fill(colleague);
  await approve.click();
  const named = { phrase: "Your colleague" };
  await expect(text(ready, "approvals.up_next.gate.colleague_signal", named)).toBeVisible();
  await expect(text(ready, "approvals.up_next.gate.red_lines", line)).toHaveCount(0);
  await expect(box).toHaveValue(colleague);
  await box.fill(textOf("ready").replace("today", "this week"));
  await approve.click();
  await expect(ready).toHaveCount(0);
  await expect(counted(page, "decided_today", 1)).toBeVisible();

  const failed = rowOf(page, "failed");
  const field = failed.getByRole("textbox", { name: t("approvals.up_next.text") });
  await expect(field).toHaveValue("");
  await expect(button(failed, "approvals.up_next.action.approve")).toBeDisabled();
  await field.fill(textOf("failed"));
  await button(failed, "approvals.up_next.action.approve").click();
  await expect(failed).toHaveCount(0);
  await expect(counted(page, "decided_today", 2)).toBeVisible();

  const connect = rowOf(page, "connect");
  await expect(text(connect, "approvals.up_next.empty_note")).toBeVisible();
  await button(connect, "approvals.up_next.action.approve").click();
  await expect(connect).toHaveCount(0);
  await expect(counted(page, "decided_today", 3)).toBeVisible();
  await expect(text(page, "approvals.up_next.empty")).toBeVisible();
  await axe(page);
});

test("a drafting row shows a spinner and no Approve, then its text once its draft is ready, without a reload; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const seeded = await seed(page, baseURL, ["drafting"]);
  await page.goto(PATH);
  const row = rowOf(page, "drafting");
  await expect(row.getByRole("status")).toHaveText(t("approvals.up_next.drafting"));
  await expect(button(row, "approvals.up_next.action.approve")).toHaveCount(0);
  await expect(button(row, "approvals.up_next.action.skip")).toBeVisible();
  await axe(page);
  await page.evaluate(() => Reflect.set(window, "upNextKept", true));
  const url = `${API}/e2e/up-next/drafts/${seeded.drafting.draftId}`;
  const data = { status: "ready", text: LATER };
  const answer = await page.request.post(url, { data, headers: { origin: baseURL ?? "" } });
  expect(await answer.json()).toEqual({ written: 1, attached: 1 });
  await expect(row.getByText(LATER, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(button(row, "approvals.up_next.action.approve")).toBeEnabled();
  await expect(row.getByRole("status")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "upNextKept"))).toBe(true);
  await axe(page);
});

test("a member who does not own the sender account sees Approve, Edit and Skip disabled, with the hint; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, ["ready", "failed"]);
  await signInAs("e2e-usage@example.com");
  await page.goto(PATH);
  const ready = rowOf(page, "ready");
  const hint = t("approvals.up_next.hint.not_owner");
  await expect(text(ready, "approvals.up_next.hint.not_owner")).toBeVisible();
  for (const action of ["approve", "edit", "skip"]) {
    const control = button(ready, `approvals.up_next.action.${action}`);
    await expect(control).toBeDisabled();
    await expect(control).toHaveAccessibleDescription(hint);
  }
  const failed = rowOf(page, "failed");
  await expect(failed.getByRole("textbox")).toHaveCount(0);
  await expect(button(failed, "approvals.up_next.action.approve")).toBeDisabled();
  await axe(page);
});

test("the screen's states: loading while its read is held, then empty; a failed read in words, with Try again; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, []);
  const path = "/approvals/items";
  await cookie(context, baseURL, "e2e_hold", path);
  await page.goto(PATH, { waitUntil: "commit" });
  const main = page.getByRole("main");
  await expect(main.getByRole("status").filter({ hasText: t("ui.state.loading") })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("approvals.up_next.title"));
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const empty = text(page, "approvals.up_next.empty");
  await expect(empty).toBeVisible();
  await expect(counted(page, "to_approve", 0)).toBeVisible();
  await axe(page);

  await cookie(context, baseURL, "e2e_fail", path);
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(t("approvals.up_next.error"));
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(t("platform.error.generic"));
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await press(button(alert, "ui.action.retry"), empty);
  await expect(alert).toHaveCount(0);
});

test("at a phone's width, 390×844, the rows, a field and the facts fit: nothing scrolls sideways", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs();
  await seed(page, baseURL);
  await page.goto(PATH);
  const ready = rowOf(page, "ready");
  const facts = ready.getByRole("region", { name: t("approvals.up_next.facts.title") });
  await press(button(ready, "approvals.up_next.facts.show"), facts.getByRole("listitem").first());
  await button(rowOf(page, "flagged"), "approvals.up_next.action.edit").click();
  await expect(rowOf(page, "flagged").getByRole("textbox")).toBeVisible();
  expect(await overflows(page)).toEqual([]);
});
