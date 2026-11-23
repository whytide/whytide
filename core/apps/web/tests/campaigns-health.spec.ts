// campaigns' Health page, its LinkedIn senders' section (gamma-p6-085; core/modules/campaigns/README.md
// "Screens"), on the accounts and health events the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e, POST …/e2e/health) in wsp_e2e_health, this spec's alone, whose
// E2E_USERS are Owners (core/apps/api/tests/e2e-server.ts) and Mia a Member the module makes
// (POST …/e2e/members): "Health" in the results group after Results; an Owner's card per account,
// the signed-in user's, Mia's and a former member's, each naming its owner, its connection, its
// pause and who holds it, its health since its change, the cool-down's end, the pending invitations
// and its last 5 events of 6, newest first, every time in the account's zone, Paris, named, while
// the browser runs in New York; the link to linkedin's page; Mia's own account alone, without owner
// names; no account, the empty state with the way to connect one; the section's loading state while
// the browser's read of the accounts waits, its error state, whose Try again reads again; one card's
// failed health read beside the other cards' health; a phone's width. The browser reads linkedin's
// routes itself, so page.route holds and fails them. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_health";
const PATH = `/w/${WORKSPACE}/health`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
const ACCOUNTS = `${API}/linkedin/accounts`;
const MIA = { email: "e2e-health-mia@example.com", displayName: "Mia Health", role: "Member" };
/** The accounts' zone, and the browser's, another. */
const ZONE = "Europe/Paris";
const BROWSER_ZONE = "America/New_York";
const TIME_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Event = { from: string; to: string; trigger: string; at: string };

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
  messages: nest({ ...campaigns, ...linkedin, ...platform, ...ui, ...web }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;
const say = (key: string, values?: Record<string, string | number>) =>
  t(`campaigns.health.${key}`, values);

const FOUNDER = "Founder's LinkedIn";
const MIAS = "Mia's LinkedIn";
const OLD = "Old LinkedIn";
/** The founder's six events, oldest first: the card shows the last five, newest first. */
const FOUNDER_EVENTS: Event[] = [
  { from: "healthy", to: "at_risk", trigger: "acceptance_rate", at: "2026-11-01T08:00:00.000Z" },
  { from: "at_risk", to: "healthy", trigger: "manual", at: "2026-11-02T09:15:00.000Z" },
  {
    from: "healthy",
    to: "disconnected",
    trigger: "session_invalid",
    at: "2026-11-03T10:30:00.000Z",
  },
  { from: "disconnected", to: "healthy", trigger: "manual", at: "2026-11-04T11:45:00.000Z" },
  { from: "healthy", to: "healthy", trigger: "rate_limit_errors", at: "2026-11-05T12:00:00.000Z" },
  { from: "healthy", to: "restricted", trigger: "limit_reached", at: "2026-11-11T07:30:00.000Z" },
];
const COOLDOWN_END = "2026-11-14T07:30:00.000Z";
const OLD_EVENT: Event = {
  ...{ from: "healthy", to: "disconnected", trigger: "session_invalid" },
  at: "2026-11-08T13:45:00.000Z",
};

/** The signed-in user's restricted account, Mia's paused one, a former member's lost one. */
function scenario() {
  const account = { timeZone: ZONE, status: "connected" };
  return [
    {
      ...{ ...account, label: FOUNDER, state: "restricted", pausedUntil: COOLDOWN_END },
      ...{ pendingInvites: 12, events: FOUNDER_EVENTS },
    },
    {
      ...{ ...account, label: MIAS, ownerEmail: MIA.email, pausedBy: "tester" },
      ...{ state: "healthy", pendingInvites: null, events: [] },
    },
    {
      ...{ ...account, label: OLD, former: true, status: "disconnected" },
      ...{ pausedBy: "member_removed", state: "disconnected", pendingInvites: 0 },
      events: [OLD_EVENT],
    },
  ];
}

/** Mia made a Member, then the workspace's accounts replaced with these. */
async function seed(page: Page, origin: string | undefined, accounts: unknown[]) {
  const headers = { origin: origin ?? "" };
  const members = await page.request.post(`${API}/e2e/members`, {
    data: { members: [MIA] },
    headers,
  });
  expect(members.status(), await members.text()).toBe(200);
  const answer = await page.request.post(`${API}/e2e/health`, { data: { accounts }, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { accountIds: string[] }).accountIds;
}

/** linkedin's accounts as the route answers the signed-in user. */
async function accounts(page: Page) {
  const answer = await page.request.get(ACCOUNTS);
  expect(answer.status()).toBe(200);
  type Account = { id: string; label: string; ownerName: string | null };
  return ((await answer.json()) as { accounts: Account[] }).accounts;
}

async function axe(page: Page) {
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

/** An instant as the browser words it in a zone, in the page's format. */
const worded = (page: Page, at: string, timeZone: string) =>
  page.evaluate(
    ([instant, zone, format]) =>
      new Intl.DateTimeFormat("en", { ...format, timeZone: zone }).format(new Date(instant)),
    [at, timeZone, TIME_FORMAT] as const,
  );

const section = (page: Page) =>
  page.getByRole("region", { name: say("senders.title"), exact: true });
const card = (page: Page, label: string) => section(page).getByRole("region", { name: label });
/** A fact of a card: its label's term and the value beside it. */
const fact = (scope: Locator, key: string) =>
  scope.locator("div", { has: scope.page().getByText(say(`fact.${key}`), { exact: true }) });
const events = (scope: Locator) =>
  scope.getByRole("region", { name: say("sender.events") }).getByRole("listitem");
const state = (key: string) => t(`linkedin.health.state.${key}`);
const trigger = (key: string) => t(`linkedin.health.trigger.${key}`);

test.use({ timezoneId: BROWSER_ZONE });

test.beforeEach(async ({ page, signInAs, baseURL }) => {
  await signInAs();
  await seed(page, baseURL, scenario());
});

test("Health in the results group after Results: an Owner's card per account with its owner, connection, pause, health, cool-down, pending invitations and last 5 events, every time in the account's zone, named; the link to the LinkedIn page; axe", async ({
  page,
}) => {
  test.slow(); // a seed, three cards' reads and axe
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("title"));
  await expect(page.getByText(say("description"), { exact: true })).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: t("web.nav.results") });
  await expect(group.getByRole("link")).toHaveText([
    t("campaigns.nav.results"),
    t("campaigns.nav.health"),
  ]);
  const link = group.getByRole("link", { name: t("campaigns.nav.health") });
  await expect(link).toHaveAttribute("href", PATH);
  await expect(link).toHaveAttribute("aria-current", "page");

  // Every member's account, in linkedin's order, each naming its owner, a former member's as such.
  const titles = section(page).getByRole("heading", { level: 3 });
  await expect(titles).toHaveText([FOUNDER, MIAS, OLD]);
  const owners = await accounts(page);
  const founderOwner = owners.find(({ label }) => label === FOUNDER)?.ownerName ?? "";
  const founder = card(page, FOUNDER);
  await expect(founder.getByText(say("sender.owner", { name: founderOwner }))).toBeVisible();
  const mias = card(page, MIAS);
  await expect(mias.getByText(say("sender.owner", { name: MIA.displayName }))).toBeVisible();
  const old = card(page, OLD);
  await expect(old.getByText(say("sender.owner_removed"))).toBeVisible();

  // The connection and the pause, from linkedin's list.
  await expect(fact(founder, "status")).toContainText(t("linkedin.account.status.connected"));
  await expect(fact(founder, "pause")).toContainText(say("pause.none"));
  await expect(fact(mias, "pause")).toContainText(say("pause.tester"));
  await expect(fact(old, "status")).toContainText(t("linkedin.account.status.disconnected"));
  await expect(fact(old, "pause")).toContainText(say("pause.member_removed"));

  // The health: its state since the change, the cool-down's end, the pending invitations.
  const restricted = FOUNDER_EVENTS.at(-1)?.at ?? "";
  await expect(fact(founder, "health")).toContainText(state("restricted"));
  const since = fact(founder, "health").locator("time");
  await expect(since).toHaveAttribute("datetime", restricted);
  await expect(since).toHaveText(await worded(page, restricted, ZONE));
  const cooldown = fact(founder, "cooldown").locator("time");
  await expect(cooldown).toHaveText(await worded(page, COOLDOWN_END, ZONE));
  await expect(fact(founder, "pending")).toContainText(t("linkedin.health.pending", { count: 12 }));
  await expect(fact(mias, "health")).toContainText(state("healthy"));
  await expect(fact(mias, "cooldown")).toHaveCount(0);
  await expect(fact(mias, "pending")).toContainText(t("linkedin.health.pending_unknown"));
  await expect(fact(old, "health")).toContainText(state("disconnected"));

  // The last 5 events of 6, newest first, each its state, its trigger and its time in Paris.
  const shown = FOUNDER_EVENTS.slice(1).reverse();
  const rows: string[] = [];
  for (const event of shown) {
    rows.push(`${state(event.to)}${trigger(event.trigger)}${await worded(page, event.at, ZONE)}`);
  }
  await expect(events(founder)).toHaveText(rows);
  await expect(events(founder).locator("time").first()).toHaveAttribute("datetime", restricted);
  // Paris's words, never the browser's New York.
  expect(await worded(page, restricted, ZONE)).not.toBe(
    await worded(page, restricted, BROWSER_ZONE),
  );
  await expect(events(mias)).toHaveCount(0);
  await expect(mias.getByText(say("sender.no_events"))).toBeVisible();
  await expect(events(old)).toHaveText([
    `${state("disconnected")}${trigger("session_invalid")}${await worded(page, OLD_EVENT.at, ZONE)}`,
  ]);

  // Each card leads to linkedin's page; nothing on the page acts.
  for (const scope of [founder, mias, old]) {
    const open = scope.getByRole("link", { name: say("sender.open") });
    await expect(open).toHaveAttribute("href", `/w/${WORKSPACE}/linkedin`);
  }
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await axe(page);
});

test("a Member sees her own account alone, without owner names; with no account, the empty state and the way to connect one; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs(MIA.email);
  await page.goto(PATH);
  await expect(section(page).getByRole("heading", { level: 3 })).toHaveText([MIAS]);
  const mias = card(page, MIAS);
  await expect(fact(mias, "health")).toContainText(state("healthy"));
  await expect(mias.getByText(say("sender.owner", { name: MIA.displayName }))).toHaveCount(0);
  await axe(page);

  await signInAs();
  await seed(page, baseURL, []);
  await page.goto(PATH);
  await expect(section(page).getByText(say("senders.empty"), { exact: true })).toBeVisible();
  const connect = section(page).getByRole("link", { name: say("senders.connect") });
  await expect(connect).toHaveAttribute("href", `/w/${WORKSPACE}/linkedin`);
  await expect(section(page).getByRole("heading", { level: 3 })).toHaveCount(0);
  await axe(page);
});

test("the section's loading state while its read waits; a failed read in words with Try again, which reads again; one card's failed health beside the others' health; axe on each", async ({
  page,
}) => {
  test.slow(); // a held read, a failed one, a retry, a card's failure and three axe runs
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${ACCOUNTS}`, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(PATH);
  const busy = section(page)
    .getByRole("status")
    .filter({ hasText: t("ui.state.loading") });
  await expect(busy).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("title"));
  await axe(page);
  release();
  await expect(card(page, FOUNDER)).toBeVisible();
  await page.unroute(`**${ACCOUNTS}`);

  // The accounts' read fails: the section's error, the page's header still there; Try again.
  const failure = { status: 500, json: { code: "internal_error" } };
  await page.route(`**${ACCOUNTS}`, (route) => route.fulfill(failure));
  await page.reload();
  await expect(section(page).getByText(say("senders.error"), { exact: true })).toBeVisible();
  const alert = section(page).getByRole("alert");
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("title"));
  await axe(page);
  await page.unroute(`**${ACCOUNTS}`);
  await alert.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(alert).toHaveCount(0);
  await expect(section(page).getByRole("heading", { level: 3 })).toHaveText([FOUNDER, MIAS, OLD]);

  // Mia's health read fails: her card says so with Try again, the other cards keep their health.
  const miaId = (await accounts(page)).find(({ label }) => label === MIAS)?.id ?? "";
  const health = `**${ACCOUNTS}/${miaId}/health`;
  await page.route(health, (route) => route.fulfill(failure));
  await page.reload();
  const mias = card(page, MIAS);
  await expect(mias.getByText(say("sender.error"), { exact: true })).toBeVisible();
  await expect(mias.getByRole("alert")).toContainText(t("platform.error.generic"));
  await expect(fact(mias, "pause")).toContainText(say("pause.tester"));
  await expect(fact(card(page, FOUNDER), "health")).toContainText(state("restricted"));
  await expect(fact(card(page, OLD), "health")).toContainText(state("disconnected"));
  await axe(page);
  await page.unroute(health);
  await mias.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(fact(mias, "health")).toContainText(state("healthy"));
  await expect(mias.getByRole("alert")).toHaveCount(0);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the cards and their events fit: nothing wider than the phone", async ({ page }) => {
    await page.goto(PATH);
    await expect(events(card(page, FOUNDER))).toHaveCount(5);
    await page.waitForLoadState("networkidle");
    expect(await overflows(page)).toEqual([]);
    for (const label of [FOUNDER, MIAS, OLD]) {
      const wider = await card(page, label).evaluate((box) => box.scrollWidth - box.clientWidth);
      expect(wider, label).toBeLessThanOrEqual(0);
    }
  });
});
