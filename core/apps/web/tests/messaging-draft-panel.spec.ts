// messaging's draft panel in the draft slot of contacts' lead page (alpha-p9-030;
// core/modules/messaging/README.md "The draft panel"), on a lead and its drafts that the e2e api's
// test-only module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_drafts, this spec's alone.
// The e2e api runs no worker: a draft asked for stays `drafting` until the e2e module writes it as
// its writer leaves it, and the panel's next poll shows it. Note and Draft, then the draft with its
// counter, plan, facts and their sources, and gates; Edit and Save, the counter in the danger
// colour and Save refused above the limit; Regenerate on top of the edited draft, kept in the
// history; a flagged draft's reasons without Copy; a failed one's reason, for each of the four
// codes; the panel absent for another workspace's person. Every text from its key, through
// next-intl's translator over the module's messages; axe on each state. Copy and the clipboard,
// which Chromium alone grants, are messaging-states.spec.ts's.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import messaging from "../../../modules/messaging/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_drafts";
const LEAD = {
  slug: "e2e-drafts-lead",
  firstName: "Draft",
  lastName: "Lead",
  headline: "Data leader at a software company",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  locationText: "Lisbon, Portugal",
  source: "imported",
};
const NOTE =
  "Draft, as Head of Data at Blue Harbor Labs, how does your team follow up on warm leads today?";
const EDITED = NOTE.replace("today", "this week");
const AGAIN =
  "Draft, a short question for the Head of Data at Blue Harbor Labs: who answers warm leads?";
const GATES = [
  "facts_used",
  "placeholders",
  "length",
  "grounding",
  "red_lines",
  "colleague_signal",
];
/** A failed draft's codes (README.md "The writer"). */
const FAILURES = [
  "ai_failed",
  "draft_requester_not_member",
  "dossier_lead_not_found",
  "write_failed",
];

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
  messages: nest({ ...contacts, ...messaging }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** The drafts written in the person's dossier: a ready note on three of its facts, unless changed. */
const written = (dossier: Dossier, text: string, change: Record<string, unknown> = {}) => {
  const fact = (column: string) => dossier.facts.find((f) => f.sourceRef.endsWith(`/${column}`));
  const factIds = ["first_name", "title", "company_name"].map((column) => fact(column)?.id);
  const plan = { angle: "pain_point", factIds, cta: "question" };
  return { status: "ready", plan, text, dossierHash: dossier.dossierHash, ...change };
};

/**
 * The workspace's one lead, its dossier, and its drafts as `drafts` builds them, oldest first; the
 * channel's limit as the api answers it.
 */
async function seed(
  page: Page,
  origin: string | undefined,
  drafts: (dossier: Dossier) => object[] = () => [],
) {
  const headers = { origin: origin ?? "" };
  const e2e = `/api/v1/workspaces/${WORKSPACE}/e2e`;
  const leads = await page.request.post(`${e2e}/leads`, { data: { leads: [LEAD] }, headers });
  expect(leads.status(), await leads.text()).toBe(200);
  const [personId = ""] = ((await leads.json()) as { personIds: string[] }).personIds;
  const lead = `/api/v1/workspaces/${WORKSPACE}/messaging/leads/${personId}`;
  const read = await page.request.get(`${lead}/dossier`);
  expect(read.status(), await read.text()).toBe(200);
  const dossier = (await read.json()) as Dossier;
  const data = { personId, drafts: drafts(dossier) };
  const seeded = await page.request.post(`${e2e}/drafts`, { data, headers });
  expect(seeded.status(), await seeded.text()).toBe(200);
  const list = await page.request.get(`${lead}/drafts`);
  const [newest] = ((await list.json()) as { drafts: { maxCharacters: number }[] }).drafts;
  return { personId, dossier, max: newest?.maxCharacters ?? 0 };
}

/** The draft written as its writer leaves it, by the e2e module in the worker's stead. */
async function write(page: Page, origin: string | undefined, id: string, columns: object) {
  const url = `/api/v1/workspaces/${WORKSPACE}/e2e/drafts/${id}`;
  const answer = await page.request.post(url, { data: columns, headers: { origin: origin ?? "" } });
  expect(await answer.json()).toEqual({ written: 1 });
}

/** A press lost before the page hydrates is pressed again, until `then` shows. */
async function press(button: Locator, then: Locator) {
  await expect(async () => {
    if (!(await then.isVisible())) await button.click({ timeout: 1_000 });
    await expect(then).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

/** The POSTs the page sends to messaging's routes. */
function posts(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/messaging/"))
      sent.push(request.url());
  });
  return sent;
}

/** The danger colour as the browser computes it. */
const danger = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--color-danger-ink)";
    document.body.append(probe);
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  });

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: t("messaging.draft.title") });
const listOf = (scope: Locator, key: string) =>
  scope.getByRole("list", { name: t(key), exact: true });
const button = (scope: Locator, key: string) =>
  scope.getByRole("button", { name: t(key), exact: true });
const isPost =
  (path: RegExp) => (r: { request: () => { method: () => string }; url: () => string }) =>
    r.request().method() === "POST" && path.test(new URL(r.url()).pathname);

test("note and Draft: one request, the draft being written with Draft and Regenerate disabled; the next poll shows it, its counter, its plan with the facts and their sources, its gates; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { personId, dossier } = await seed(page, baseURL);
  const sent = posts(page);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  await expect(panel.getByText(t("messaging.draft.nothing_sent"), { exact: true })).toBeVisible();
  await panel.getByRole("radio", { name: t("messaging.draft.channel.note") }).check();
  const writing = panel.getByRole("status").filter({ hasText: t("messaging.draft.drafting") });
  const answered = page.waitForResponse(isPost(/\/messaging\/leads\/[^/]+\/drafts$/));
  await press(button(panel, "messaging.draft.create"), writing);
  const asked = (await (await answered).json()) as {
    id: string;
    channel: string;
    maxCharacters: number;
  };
  expect([sent.length, asked.channel]).toEqual([1, "linkedin_note"]);
  await expect(button(panel, "messaging.draft.create")).toBeDisabled();
  await expect(button(panel, "messaging.draft.regenerate")).toBeDisabled();

  await write(page, baseURL, asked.id, written(dossier, NOTE));
  const current = panel.locator('[data-part="draft"]');
  await expect(current.getByText(NOTE, { exact: true })).toBeVisible({ timeout: 10_000 });
  const count = { count: NOTE.length, max: asked.maxCharacters };
  await expect(
    current.getByText(t("messaging.draft.counter", count), { exact: true }),
  ).toBeVisible();
  await expect(listOf(panel, "messaging.draft.plan").getByRole("listitem")).toHaveText([
    t("messaging.draft.angle.pain_point"),
    t("messaging.draft.cta.question"),
  ]);
  const source = (column: string) => t("messaging.draft.source.persons", { column });
  await expect(listOf(panel, "messaging.draft.facts").getByRole("listitem")).toHaveText([
    `Draft ${source("first_name")}`,
    `Head of Data ${source("title")}`,
    `Blue Harbor Labs ${source("company_name")}`,
  ]);
  await expect(panel).not.toContainText("persons/");
  const passed = (gate: string) =>
    t("messaging.draft.gate_result", { gate: t(`messaging.draft.gate.${gate}`), result: "passed" });
  await expect(listOf(panel, "messaging.draft.gates").locator(":scope > li")).toHaveText(
    GATES.map(passed),
  );
  await expect(button(panel, "messaging.draft.create")).toBeEnabled();
  await axe(page);
});

test("Edit, a word changed, Save: the edited text and mark; above the limit the counter turns to the danger colour and Save refuses; Regenerate asks once, the new draft on top while the edited one stays in the history, then the next poll shows it; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { personId, dossier, max } = await seed(page, baseURL, (d) => [written(d, NOTE)]);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const current = panel.locator('[data-part="draft"]');
  const box = current.getByRole("textbox", { name: t("messaging.draft.text") });
  await press(button(current, "messaging.draft.edit"), box);
  await expect(box).toHaveValue(NOTE);
  const save = button(current, "messaging.draft.save");
  const long = Array.from({ length: Math.ceil(max / NOTE.length) + 1 }, () => NOTE).join(" ");
  await box.fill(long);
  const over = current.getByText(t("messaging.draft.counter", { count: long.length, max }));
  await expect(over).toHaveCSS("color", await danger(page));
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await expect(save).toBeDisabled();

  await box.fill(EDITED);
  await save.click();
  await expect(current.getByText(EDITED, { exact: true })).toBeVisible();
  await expect(current.getByText(t("messaging.draft.edited"), { exact: true })).toBeVisible();
  await expect(current.getByText(t("messaging.draft.gates_generated"))).toBeVisible();
  await axe(page);

  const sent = posts(page);
  const answered = page.waitForResponse(isPost(/\/messaging\/drafts\/[^/]+\/regenerate$/));
  await button(current, "messaging.draft.regenerate").click();
  const again = (await (await answered).json()) as { id: string };
  await expect(
    panel.getByRole("status").filter({ hasText: t("messaging.draft.drafting") }),
  ).toBeVisible();
  expect(sent).toHaveLength(1);
  await expect(button(panel, "messaging.draft.create")).toBeDisabled();
  await expect(button(panel, "messaging.draft.regenerate")).toBeDisabled();
  const history = listOf(panel, "messaging.draft.history").getByRole("listitem");
  await expect(history).toHaveCount(2);
  await expect(history.nth(0)).toContainText(t("messaging.draft.drafting"));
  await expect(history.nth(1)).toContainText(EDITED);
  await expect(history.nth(1)).toContainText(t("messaging.draft.edited"));

  await write(page, baseURL, again.id, written(dossier, AGAIN));
  await expect(current.getByText(AGAIN, { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(history.nth(0)).toContainText(AGAIN);
  await expect(history.nth(1)).toContainText(EDITED);
  await axe(page);
});

test("a flagged draft shows its reasons, the entity that failed grounding, and no Copy; a failed one shows its code's reason, for each of the four; another workspace's person has no panel; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const issue = { gate: "grounding", entity: "Globex" };
  const gates = GATES.map((gate) => ({ gate, issues: gate === "grounding" ? [issue] : [] }));
  const text = "Draft, Globex follows up on warm leads within the hour. Does your team?";
  const flagged = { status: "flagged", gates, flagReasons: [issue] };
  const { personId } = await seed(page, baseURL, (d) => [written(d, text, flagged)]);
  await page.goto(leadPath(personId));
  const panel = panelOf(page);
  const current = panel.locator('[data-part="draft"]');
  const reason = t("messaging.gate.grounding", { entity: "Globex" });
  await expect(listOf(current, "messaging.draft.flagged").getByRole("listitem")).toHaveText([
    reason,
  ]);
  await expect(current.getByText(text, { exact: true })).toBeVisible();
  await expect(button(current, "messaging.draft.copy")).toHaveCount(0);
  const grounding = t("messaging.draft.gate_result", {
    gate: t("messaging.draft.gate.grounding"),
    result: "failed",
  });
  await expect(listOf(panel, "messaging.draft.gates").locator(":scope > li").nth(3)).toHaveText(
    `${grounding}${reason}`,
  );
  await axe(page);

  for (const code of FAILURES) {
    const failed = { status: "failed", plan: null, text: null, gates: [], flagReasons: [{ code }] };
    await seed(page, baseURL, (d) => [written(d, text, failed)]);
    await page.reload();
    await expect(current.getByText(t("messaging.draft.failed"), { exact: true })).toBeVisible();
    const why = t(`messaging.draft.failure.${code}`);
    await expect(current.getByText(why, { exact: true })).toBeVisible();
    await expect(button(current, "messaging.draft.copy")).toHaveCount(0);
  }
  await axe(page);

  await page.goto(`/w/wsp_e2e_b/leads/${personId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("contacts.lead.not_found"));
  await expect(panel).toHaveCount(0);
});
