// campaigns' enrollment panel in the outreach slot of contacts' lead page (beta-p2-060;
// core/modules/campaigns/README.md "Screens"), on leads and enrollments that the e2e api's test-only
// module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_enrollment, this spec's alone, whose
// connected account sends from Europe/Paris while the browser runs in America/New_York: an active
// enrollment's steps, each with its status, its time in the sender's zone with the zone named, and
// why one waits, was skipped or is held; one just made, whose later steps say what they wait for; two
// that never started, newest first, each with why in words; a person without one, the empty state;
// the slot's loading state while the e2e api holds the read, and the panel's error state when it
// fails it, whose Try again reads again (tests/e2e-hold.ts); and the active and the refused ones at a
// phone's width, nothing wider than it. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_enrollment";
const E2E = `/api/v1/workspaces/${WORKSPACE}/e2e`;
/** The panel's read, whose path the e2e api's hold and fail cookies name. */
const READ = "/campaigns/enrollments";
/** The zone of the workspace's connected account (core/apps/api/tests/e2e-signals.ts). */
const ZONE = "Europe/Paris";
const LEADS = [
  { slug: "e2e-enrollment-active", firstName: "Ada", lastName: "Active", source: "imported" },
  { slug: "e2e-enrollment-new", firstName: "Nils", lastName: "New", source: "imported" },
  { slug: "e2e-enrollment-refused", firstName: "Rita", lastName: "Refused", source: "imported" },
  { slug: "e2e-enrollment-none", firstName: "Nora", lastName: "None", source: "imported" },
];
/** Instants and their words in Paris (UTC+1 from 25 October 2026); New York is UTC-4 till November. */
const SENT = { at: "2026-10-27T08:30:00.000Z", paris: "Oct 27, 2026, 9:30 AM" };
const SCHEDULED = { at: "2026-10-28T12:15:00.000Z", paris: "Oct 28, 2026, 1:15 PM" };
const DUE = { at: "2026-10-29T16:45:00.000Z", paris: "Oct 29, 2026, 5:45 PM" };

/** The request sent; the first message waiting for another day; a follow-up skipped, one held. */
const ACTIVE = {
  status: "active",
  steps: [
    {
      ...{ stepKey: "connect", status: "succeeded" },
      ...{ dueAt: "2026-10-27T08:00:00.000Z", executedAt: SENT.at },
    },
    {
      ...{ stepKey: "message_1", status: "scheduled", errorCode: "touched_today" },
      ...{ dueAt: "2026-10-28T11:00:00.000Z", scheduledFor: SCHEDULED.at },
    },
    { stepKey: "follow_up_1", status: "skipped", skipReason: "never_contact_company" },
    { stepKey: "follow_up_2", status: "held", skipReason: "replied" },
  ],
};
/** Just made: the request due, the messages waiting for what they follow. */
const FRESH = {
  status: "active",
  steps: [
    { stepKey: "connect", status: "planned", dueAt: DUE.at },
    { stepKey: "message_1", status: "planned" },
    { stepKey: "follow_up_1", status: "planned" },
    { stepKey: "follow_up_2", status: "planned" },
  ],
};
/** Refused as they were made, oldest first: no account to send from, then contacted too recently. */
const REFUSED = [
  { status: "exited", exitReason: "no_sender" },
  { status: "exited", exitReason: "suppressed", exitDetail: "recently_contacted" },
];

type Translate = (key: string, values?: Record<string, string>) => string;

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
  messages: nest({ ...campaigns, ...platform, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** The workspace's four leads, and each person's enrollments replaced by its own; their ids. */
async function seed(page: Page, origin: string | undefined) {
  const headers = { origin: origin ?? "" };
  const leads = await page.request.post(`${E2E}/leads`, { data: { leads: LEADS }, headers });
  expect(leads.status(), await leads.text()).toBe(200);
  const { personIds } = (await leads.json()) as { personIds: string[] };
  const [active = "", fresh = "", refused = "", none = ""] = personIds;
  const seeded: [string, object[]][] = [
    [active, [ACTIVE]],
    [fresh, [FRESH]],
    [refused, REFUSED],
    [none, []],
  ];
  for (const [personId, enrollments] of seeded) {
    const data = { personId, enrollments };
    const answer = await page.request.post(`${E2E}/enrollments`, { data, headers });
    expect(answer.status(), await answer.text()).toBe(200);
  }
  return { active, fresh, refused, none };
}

/** The e2e api holds (`e2e_hold`) or fails (`e2e_fail`) each read of the panel's path. */
const cookie = (context: BrowserContext, origin: string | undefined, name: string) =>
  context.addCookies([{ name, value: encodeURIComponent(READ), url: origin ?? "" }]);

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

const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: t("campaigns.enrollment.title") });
const enrollmentsOf = (panel: Locator) => panel.locator('[data-part="enrollment"]');
const stepsOf = (scope: Locator) =>
  scope.getByRole("list", { name: t("campaigns.enrollment.steps"), exact: true });
/** A time line: the words of `key` with the time in Paris and the zone named. */
const at = (key: string, time: string) =>
  t(`campaigns.enrollment.time.${key}`, { time, zone: ZONE });
/** A step as its row reads: its name, its status, then its lines. */
const step = (key: string, status: string, ...lines: string[]) =>
  [
    t(`campaigns.enrollment.step.${key}`),
    t(`campaigns.enrollment.step_status.${status}`),
    ...lines,
  ].join(" ");
/** The rows' words, a line apart, as a reader reads them. */
const read = { useInnerText: true };

test.use({ timezoneId: "America/New_York" });

test("an active enrollment's steps by position, each with its status, its time in the sender's zone with the zone named, and why one waits, was skipped or is held; one just made says what its later steps wait for; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { active, fresh } = await seed(page, baseURL);
  await page.goto(leadPath(active));
  const panel = panelOf(page);
  const enrollment = enrollmentsOf(panel);
  await expect(enrollment).toHaveCount(1);
  const steps = stepsOf(enrollment).getByRole("listitem");
  await expect(steps).toHaveText(
    [
      step("connect", "succeeded", at("sent", SENT.paris)),
      step(
        "message_1",
        "scheduled",
        at("scheduled", SCHEDULED.paris),
        t("campaigns.reason.touched_today"),
      ),
      step("follow_up_1", "skipped", t("campaigns.reason.never_contact_company")),
      step("follow_up_2", "held", t("campaigns.reason.replied")),
    ],
    read,
  );
  await expect(enrollment.locator("p").first()).toHaveText(t("campaigns.enrollment.status.active"));
  // Each time carries its instant; the words are Paris's, never the browser's New York.
  const times = steps.locator("time");
  await expect(times).toHaveCount(2);
  await expect(times.nth(0)).toHaveAttribute("datetime", SENT.at);
  await expect(times.nth(1)).toHaveAttribute("datetime", SCHEDULED.at);
  await axe(page);

  await page.goto(leadPath(fresh));
  await expect(stepsOf(panel).getByRole("listitem")).toHaveText(
    [
      step("connect", "planned", at("due", DUE.paris)),
      step("message_1", "planned", t("campaigns.enrollment.time.after_acceptance")),
      step("follow_up_1", "planned", t("campaigns.enrollment.time.after_previous")),
      step("follow_up_2", "planned", t("campaigns.enrollment.time.after_previous")),
    ],
    read,
  );
  await expect(stepsOf(panel).locator("time")).toHaveAttribute("datetime", DUE.at);
  await axe(page);
});

test("enrollments that never started, newest first: each says Not started and why in words, the suppression reason after its exit reason, and has no step; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { refused } = await seed(page, baseURL);
  await page.goto(leadPath(refused));
  const panel = panelOf(page);
  const refusedWord = t("campaigns.enrollment.status.refused");
  await expect(enrollmentsOf(panel)).toHaveText(
    [
      `${refusedWord} ${t("campaigns.reason.suppressed")} ${t("campaigns.reason.recently_contacted")}`,
      `${refusedWord} ${t("campaigns.reason.no_sender")}`,
    ],
    read,
  );
  await expect(stepsOf(panel)).toHaveCount(0);
  await axe(page);
});

test("the slot loads while the api holds the read; a person without an enrollment is the empty state, which says that Approve starts one; a read the api fails is the panel's error state, whose Try again reads again; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { none } = await seed(page, baseURL);
  await cookie(context, baseURL, "e2e_hold");
  await page.goto(leadPath(none), { waitUntil: "commit" });
  const slot = page.locator('[data-slot="outreach"]');
  await expect(slot.getByRole("status")).toHaveText(t("ui.state.loading"));
  await axe(page);
  const panel = panelOf(page);
  const empty = panel.getByText(t("campaigns.enrollment.empty"), { exact: true });
  await expect(empty).toBeVisible({ timeout: 10_000 });
  await expect(slot.getByRole("status")).toHaveCount(0);
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });

  await cookie(context, baseURL, "e2e_fail");
  await page.reload();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  await expect(empty).toHaveCount(0);
  // The rest of the page stands.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nora None");
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await alert.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(empty).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the active enrollment's steps and the refused enrollments fit: nothing wider than the phone, the panel included", async ({
    page,
    signInAs,
    baseURL,
  }) => {
    await signInAs();
    const { active, refused } = await seed(page, baseURL);
    for (const [personId, shown] of [
      [active, at("scheduled", SCHEDULED.paris)],
      [refused, t("campaigns.reason.no_sender")],
    ] as const) {
      await page.goto(leadPath(personId));
      const panel = panelOf(page);
      await expect(panel.getByText(shown, { exact: true })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await overflows(page), personId).toEqual([]);
      const wider = await panel.evaluate((box) => box.scrollWidth - box.clientWidth);
      expect(wider, personId).toBeLessThanOrEqual(0);
    }
  });
});
