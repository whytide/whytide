// campaigns' counts page (beta-p7-010; core/modules/campaigns/README.md "Screens"), on the enrollments
// and steps the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in
// wsp_e2e_counts, this spec's alone, from the signed-in user's account in Asia/Kolkata while the
// browser runs in America/New_York: "Counts" in the LinkedIn group after the accounts; a card per
// sender account by label, its zone named, its table's four rows by today, the last 7 days and since
// the start, the days Kolkata's (a send at 23:30 local yesterday not today, one at 00:10 local today
// today, one seven local days ago only since the start); every other step status, a withdrawal and a
// completed sequence left out; an account linkedin no longer holds last, in UTC. Without an
// enrollment, the empty state; the loading state while the e2e api holds the read, and the error
// state when it fails it, whose Try again reads again (core/apps/api/tests/e2e-hold.ts); a phone's
// width, each table within its card. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_counts";
const PATH = `/w/${WORKSPACE}/counts`;
const E2E = `/api/v1/workspaces/${WORKSPACE}/e2e`;
/** The page's read, whose path the e2e api's hold and fail cookies name. */
const READ = "/campaigns/counts";
const LABEL = "Counts e2e";
const ZONE = "Asia/Kolkata";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Kolkata keeps UTC+05:30 all year: its local times are plain arithmetic. */
const KOLKATA_OFFSET = 5.5 * HOUR;
const STATUSES = [
  "planned",
  "awaiting_approval",
  "scheduled",
  "executing",
  "failed",
  "skipped",
  "held",
  "cancelled",
] as const;

type Translate = (key: string, values?: Record<string, string>) => string;
type Step = {
  stepKey: string;
  status: string;
  actionType?: string;
  executedAt?: string;
  acceptedAt?: string;
};
type Enrollment = {
  status: string;
  endedAt?: string;
  removedAccount?: boolean;
  steps: Step[];
};

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

/** The instant of a local time in Kolkata, `days` local days before today. */
function kolkata(days: number, time: string): string {
  const today = new Date(Date.now() + KOLKATA_OFFSET).toISOString().slice(0, "YYYY-MM-DD".length);
  return new Date(Date.parse(`${today}T${time}:00Z`) - days * DAY - KOLKATA_OFFSET).toISOString();
}

/**
 * Five sequences, each a person of its own, then a step in every other status, a withdrawal, and a
 * request from an account linkedin no longer holds. In Kolkata: connection requests 1 today, 3 in the
 * last 7 days, 6 since the start; messages 2, 4, 5; acceptances 1, 2, 4; replies 1, 1, 2.
 */
function scenario(): Enrollment[] {
  const now = new Date().toISOString();
  const yesterday = kolkata(1, "23:30");
  const early = kolkata(0, "00:10");
  const [three, seven, twenty] = [kolkata(3, "12:00"), kolkata(7, "12:00"), kolkata(20, "12:00")];
  const sent = (stepKey: string, executedAt: string, acceptedAt?: string): Step => ({
    ...{ stepKey, status: "succeeded", executedAt },
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
  });
  const waiting = (status: string) =>
    ["follow_up_1", "follow_up_2"].map((stepKey) => ({ stepKey, status }));
  return [
    {
      ...{ status: "replied", endedAt: now },
      steps: [sent("connect", three, yesterday), sent("message_1", early), ...waiting("held")],
    },
    {
      ...{ status: "completed", endedAt: yesterday },
      steps: [
        sent("connect", twenty, twenty),
        sent("message_1", seven),
        sent("follow_up_1", three),
        sent("follow_up_2", yesterday),
      ],
    },
    {
      status: "active",
      steps: [sent("connect", now), { stepKey: "message_1", status: "planned" }],
    },
    {
      status: "active",
      steps: [sent("connect", yesterday, now), sent("message_1", now), ...waiting("planned")],
    },
    {
      ...{ status: "replied", endedAt: seven },
      steps: [
        sent("connect", twenty, seven),
        { stepKey: "message_1", status: "held" },
        ...waiting("held"),
      ],
    },
    // A time on each, as a stale one could be: the status decides.
    ...STATUSES.map((status) => ({
      status: "active",
      steps: ["connect", "message_1"].map((stepKey) => ({ stepKey, status, executedAt: now })),
    })),
    {
      ...{ status: "exited", endedAt: now },
      steps: [sent("connect", twenty), { ...sent("withdraw", now), actionType: "withdraw" }],
    },
    { status: "active", removedAccount: true, steps: [sent("connect", now)] },
  ];
}

/** The workspace's enrollments replaced with these, from the user's account in Kolkata. */
async function seed(page: Page, origin: string | undefined, enrollments: Enrollment[]) {
  const data = { account: { label: LABEL, timeZone: ZONE }, enrollments };
  const answer = await page.request.post(`${E2E}/counts`, {
    data,
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

/** The e2e api holds (`e2e_hold`) or fails (`e2e_fail`) each read of the page's path. */
const cookie = (context: BrowserContext, origin: string | undefined, name: string) =>
  context.addCookies([{ name, value: encodeURIComponent(READ), url: origin ?? "" }]);

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

const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const table = (scope: Locator, account: string) =>
  scope.getByRole("table", { name: t("campaigns.counts.caption", { account }) });
/** A table's rows as a reader reads them: the header, then each measure with its three numbers. */
const rows = (...measures: [string, number, number, number][]) => [
  ["measure", "today", "last_7_days", "since_start"]
    .map((column) => t(`campaigns.counts.columns.${column}`))
    .join(" "),
  ...measures.map(([key, ...numbers]) => [t(`campaigns.counts.rows.${key}`), ...numbers].join(" ")),
];
const read = { useInnerText: true };
const REMOVED = () => t("campaigns.counts.account_removed");

test.use({ timezoneId: "America/New_York" });

test("Counts in the LinkedIn group after the accounts: a card per sender account by label, its zone named, its four rows by today, the last 7 days and since the start, the days the account's; what did not go out left out; a removed account last, in UTC; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // fifteen enrollments seeded, two cards of rows read, and axe
  await signInAs();
  await seed(page, baseURL, scenario());
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("campaigns.counts.title"));
  await expect(page.getByText(t("campaigns.counts.description"), { exact: true })).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: t("web.nav.linkedin") });
  await expect(group.getByRole("link")).toHaveText([
    t("linkedin.nav.accounts"),
    t("campaigns.nav.counts"),
  ]);
  const link = group.getByRole("link", { name: t("campaigns.nav.counts") });
  await expect(link).toHaveAttribute("href", PATH);
  await expect(link).toHaveAttribute("aria-current", "page");

  // By label, the removed account last.
  const cards = page.getByRole("main").getByRole("region");
  await expect(cards.getByRole("heading", { level: 2 })).toHaveText([LABEL, REMOVED()]);
  const own = card(page, LABEL);
  await expect(own.getByText(t("campaigns.counts.zone", { zone: ZONE }))).toBeVisible();
  await expect(table(own, LABEL).getByRole("row")).toHaveText(
    rows(
      ["invites_sent", 1, 3, 6],
      ["messages_sent", 2, 4, 5],
      ["accepted", 1, 2, 4],
      ["replied", 1, 1, 2],
    ),
    read,
  );
  const removed = card(page, REMOVED());
  await expect(removed.getByText(t("campaigns.counts.zone", { zone: "UTC" }))).toBeVisible();
  await expect(table(removed, REMOVED()).getByRole("row")).toHaveText(
    rows(
      ["invites_sent", 1, 1, 1],
      ["messages_sent", 0, 0, 0],
      ["accepted", 0, 0, 0],
      ["replied", 0, 0, 0],
    ),
    read,
  );
  // Read-only: nothing on the page acts.
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await axe(page);
});

test("without an enrollment, the empty state, which says that approved steps appear once they go out; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, []);
  await page.goto(PATH);
  await expect(page.getByText(t("campaigns.counts.empty"), { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("table")).toHaveCount(0);
  await axe(page);
});

test("the loading state while the api holds the read; a failed read in words with Try again, which reads again; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  test.slow(); // a held read of three seconds, a reload, Try again and three axe runs
  await signInAs();
  await seed(page, baseURL, scenario());
  await cookie(context, baseURL, "e2e_hold");
  await page.goto(PATH, { waitUntil: "commit" });
  const main = page.getByRole("main");
  await expect(main.getByRole("status").filter({ hasText: t("ui.state.loading") })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("campaigns.counts.title"));
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const own = table(card(page, LABEL), LABEL);
  await expect(own).toBeVisible({ timeout: 10_000 });
  await expect(main.getByRole("status")).toHaveCount(0);
  await axe(page);

  await cookie(context, baseURL, "e2e_fail");
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(t("campaigns.counts.error"));
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  await expect(own).toHaveCount(0);
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await press(alert.getByRole("button", { name: t("ui.action.retry") }), own);
  await expect(alert).toHaveCount(0);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the cards and their tables fit: nothing wider than the phone", async ({
    page,
    signInAs,
    baseURL,
  }) => {
    await signInAs();
    await seed(page, baseURL, scenario());
    await page.goto(PATH);
    await expect(table(card(page, LABEL), LABEL)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await overflows(page)).toEqual([]);
    for (const name of [LABEL, REMOVED()]) {
      const wider = await card(page, name).evaluate((box) => box.scrollWidth - box.clientWidth);
      expect(wider, name).toBeLessThanOrEqual(0);
      // The table's own scroller too: no column cut off at the card's edge.
      const hidden = await table(card(page, name), name).evaluate((grid) => {
        const box = grid.parentElement;
        return box === null ? 0 : box.scrollWidth - box.clientWidth;
      });
      expect(hidden, `${name}: the table`).toBeLessThanOrEqual(0);
    }
  });
});
