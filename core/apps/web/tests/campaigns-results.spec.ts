// campaigns' Results page (gamma-p6-080; core/modules/campaigns/README.md "Screens"), on the
// campaigns, enrollments and steps the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e, POST …/e2e/funnel) in wsp_e2e_results, this spec's alone, whose
// E2E_USERS are Owners (core/apps/api/tests/e2e-server.ts) and Mia a Member the module makes
// (POST …/e2e/members): "Results" in the results group, after LinkedIn and Email; an Owner's card
// per campaign by name, the default campaign first, each with its status and its owner's name, its
// table's five stages by LinkedIn, Email and All, each number with its share of the stage above, a
// stage the channel does not count said so; when the numbers were read, in the browser's zone,
// named; Mia's own campaign alone, without owner names, and without one, the empty state; the
// loading state while the e2e api holds the read, and the error state when it fails it, whose Try
// again reads again (core/apps/api/tests/e2e-hold.ts); a phone's width, each table within its card.
// Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_results";
const PATH = `/w/${WORKSPACE}/results`;
const E2E = `/api/v1/workspaces/${WORKSPACE}/e2e`;
/** The page's read, whose path the e2e api's hold and fail cookies name. */
const READ = "/campaigns/funnel";
const MIA = { email: "e2e-results-mia@example.com", displayName: "Mia Results", role: "Member" };
const FOUNDERS = "Founders";
const MIAS = "Mia's campaign";
/** The browser's zone, which the time the numbers were read is shown in. */
const ZONE = "America/New_York";
const AS_OF_FORMAT = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
} as const;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Step = { stepKey: string; actionType?: string; status: string; executedAt?: string };
type Enrollment = {
  reply?: { label: string; at: string };
  steps: (Step & { acceptedAt?: string })[];
};
type Campaign = { name: string; ownerEmail?: string; enrollments: Enrollment[] };

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
  messages: nest({ ...campaigns, ...platform, ...ui, ...web }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** `hours` before now. */
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const sent = (stepKey: string, hours: number, more: Partial<Step> = {}) => ({
  ...{ stepKey, status: "succeeded", executedAt: ago(hours) },
  ...more,
});
const emailed = (hours: number) => sent("email_1", hours, { actionType: "email" });
const reply = (label: string, hours: number) => ({ label, at: ago(hours) });

/**
 * Founders, the signed-in user's: five people, three sent a LinkedIn step and two an email, one
 * accepted, a positive reply on LinkedIn, a not-now reply to the email, an out-of-office answer and
 * a bounce, which are no reply, and a request that failed. Mia's: one person sent a request.
 */
function scenario(): Campaign[] {
  return [
    {
      name: FOUNDERS,
      enrollments: [
        {
          reply: reply("interested", 20),
          steps: [
            { ...sent("connect", 48), acceptedAt: ago(40) },
            sent("message_1", 30),
            { stepKey: "follow_up_1", status: "held" },
          ],
        },
        { reply: reply("not_now", 20), steps: [sent("connect", 48), emailed(30)] },
        { reply: reply("out_of_office", 20), steps: [sent("connect", 48)] },
        { reply: reply("bounce", 20), steps: [emailed(30)] },
        { steps: [{ stepKey: "connect", status: "failed", executedAt: ago(48) }] },
      ],
    },
    { name: MIAS, ownerEmail: MIA.email, enrollments: [{ steps: [sent("connect", 10)] }] },
  ];
}

/** Mia made a Member, then the workspace's campaigns replaced with these. */
async function seed(page: Page, origin: string | undefined, campaigns: Campaign[]) {
  const headers = { origin: origin ?? "" };
  const members = await page.request.post(`${E2E}/members`, { data: { members: [MIA] }, headers });
  expect(members.status(), await members.text()).toBe(200);
  const answer = await page.request.post(`${E2E}/funnel`, { data: { campaigns }, headers });
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

const DEFAULT = () => t("campaigns.list.default_name");
const card = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const table = (scope: Locator, campaign: string) =>
  scope.getByRole("table", { name: t("campaigns.results.caption", { campaign }) });
/** A cell as a reader reads it: the number over its share, a dash said as not counted. */
const n = (value: number, share?: number) =>
  share === undefined ? `${value}` : `${value} ${t("campaigns.results.share", { share })}`;
const NOT = () => `${t("campaigns.results.dash")} ${t("campaigns.results.not_counted")}`;
/** A table's rows: the header, then each stage with its LinkedIn, Email and All cells. */
const rows = (...stages: [string, string, string, string][]) => [
  ["stage", "linkedin", "email", "all"].map((c) => t(`campaigns.results.columns.${c}`)).join(" "),
  ...stages.map(([key, ...cells]) => [t(`campaigns.results.rows.${key}`), ...cells].join(" ")),
];
const read = { useInnerText: true };

test.use({ timezoneId: ZONE });

test.beforeEach(async ({ page, signInAs, baseURL }) => {
  await signInAs();
  await seed(page, baseURL, scenario());
});

test("Results in the results group after LinkedIn and Email: an Owner's card per campaign by name with its status and owner, five stages by LinkedIn, Email and All, each with its share of the stage above; when read, in the browser's zone, named; axe", async ({
  page,
}) => {
  test.slow(); // two seeds, three cards of rows read, and axe
  await page.goto(PATH);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("campaigns.results.title"));
  await expect(page.getByText(t("campaigns.results.description"), { exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation");
  const group = navigation.getByRole("list", { name: t("web.nav.results") });
  await expect(group.getByRole("link")).toHaveText([t("campaigns.nav.results")]);
  const link = group.getByRole("link", { name: t("campaigns.nav.results") });
  await expect(link).toHaveAttribute("href", PATH);
  await expect(link).toHaveAttribute("aria-current", "page");
  const groups = await navigation.getByRole("heading", { level: 2 }).allTextContents();
  expect(groups.slice(-3)).toEqual([
    t("web.nav.linkedin"),
    t("web.nav.email"),
    t("web.nav.results"),
  ]);

  // When read: the browser's zone, New York's, named; never the server's.
  const time = page.getByRole("main").locator("time");
  const at = (await time.getAttribute("datetime")) ?? "";
  const words = await page.evaluate(
    ([instant, timeZone, format]) =>
      new Intl.DateTimeFormat("en", { ...format, timeZone }).format(new Date(instant)),
    [at, ZONE, AS_OF_FORMAT] as const,
  );
  await expect(time).toHaveText(words);

  // By name, the default campaign first; each with its status and its owner, who gave no name or
  // is Mia.
  const cards = page.getByRole("main").getByRole("region");
  await expect(cards.getByRole("heading", { level: 2 })).toHaveText([DEFAULT(), FOUNDERS, MIAS]);
  for (const name of [DEFAULT(), FOUNDERS, MIAS]) {
    await expect(card(page, name).getByText(t("campaigns.list.status.active"))).toBeVisible();
  }
  for (const name of [DEFAULT(), FOUNDERS]) {
    await expect(card(page, name).getByText(t("campaigns.results.owner_unknown"))).toBeVisible();
  }
  const owner = t("campaigns.results.owner", { name: MIA.displayName });
  await expect(card(page, MIAS).getByText(owner)).toBeVisible();

  await expect(table(card(page, FOUNDERS), FOUNDERS).getByRole("row")).toHaveText(
    rows(
      ["enrolled", n(5), n(5), n(5)],
      ["sent", n(3, 0.6), n(2, 0.4), NOT()],
      ["accepted", n(1, 1 / 3), NOT(), NOT()],
      ["replied", n(1, 1), n(1, 0.5), n(2, 0.4)],
      ["positive", n(1, 1), n(0, 0), n(1, 0.5)],
    ),
    read,
  );
  // No share of a stage that counted nobody.
  await expect(table(card(page, MIAS), MIAS).getByRole("row")).toHaveText(
    rows(
      ["enrolled", n(1), n(1), n(1)],
      ["sent", n(1, 1), n(0, 0), NOT()],
      ["accepted", n(0, 0), NOT(), NOT()],
      ["replied", n(0), n(0), n(0, 0)],
      ["positive", n(0), n(0), n(0)],
    ),
    read,
  );
  await expect(table(card(page, DEFAULT()), DEFAULT()).getByRole("row")).toHaveText(
    rows(
      ["enrolled", n(0), n(0), n(0)],
      ["sent", n(0), n(0), NOT()],
      ["accepted", n(0), NOT(), NOT()],
      ["replied", n(0), n(0), n(0)],
      ["positive", n(0), n(0), n(0)],
    ),
    read,
  );
  // Read-only: nothing on the page acts.
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
  await axe(page);
});

test("a Member sees her own campaign alone, without owner names; without one, the empty state; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs(MIA.email);
  await page.goto(PATH);
  const cards = page.getByRole("main").getByRole("region");
  await expect(cards.getByRole("heading", { level: 2 })).toHaveText([MIAS]);
  await expect(
    card(page, MIAS).getByText(t("campaigns.results.owner", { name: MIA.displayName })),
  ).toHaveCount(0);
  await expect(card(page, MIAS).getByText(t("campaigns.results.owner_unknown"))).toHaveCount(0);
  await expect(table(card(page, MIAS), MIAS)).toBeVisible();
  await axe(page);

  // Founders alone, the signed-in Owner's: none of Mia's.
  await signInAs();
  await seed(page, baseURL, scenario().slice(0, 1));
  await signInAs(MIA.email);
  await page.goto(PATH);
  await expect(page.getByText(t("campaigns.results.empty"), { exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("table")).toHaveCount(0);
  await axe(page);
});

test("the loading state while the api holds the read; a failed read in words with Try again, which reads again; axe on each", async ({
  page,
  context,
  baseURL,
}) => {
  test.slow(); // a held read of three seconds, a reload, Try again and three axe runs
  await cookie(context, baseURL, "e2e_hold");
  await page.goto(PATH, { waitUntil: "commit" });
  const main = page.getByRole("main");
  await expect(main.getByRole("status").filter({ hasText: t("ui.state.loading") })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(t("campaigns.results.title"));
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const founders = table(card(page, FOUNDERS), FOUNDERS);
  await expect(founders).toBeVisible({ timeout: 10_000 });
  await expect(main.getByRole("status")).toHaveCount(0);
  await axe(page);

  await cookie(context, baseURL, "e2e_fail");
  await page.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(t("campaigns.results.error"));
  const alert = main.getByRole("alert");
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  await expect(founders).toHaveCount(0);
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await press(alert.getByRole("button", { name: t("ui.action.retry") }), founders);
  await expect(alert).toHaveCount(0);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the cards and their tables fit: nothing wider than the phone", async ({ page }) => {
    await page.goto(PATH);
    await expect(table(card(page, FOUNDERS), FOUNDERS)).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await overflows(page)).toEqual([]);
    for (const name of [DEFAULT(), FOUNDERS, MIAS]) {
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
