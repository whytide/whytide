// signals' evidence panel in the evidence slot of contacts' lead page (alpha-p8-050;
// core/modules/signals/README.md "Screens"), on leads, sources and events that the e2e api's test-only
// route writes (core/apps/api/tests/e2e-signals.ts) in its evidence workspace, whose leads are this
// spec's alone: a lead found by two sources, one line per event, newest first, and the attribution;
// an imported lead's label without a list; a reduced event's summary and link; and the lead page's
// per-slot error boundary, which keeps the page and the other slots up when the fixture module's
// panel throws. Every text from its key; axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_evidence"; // the e2e api's evidence workspace (e2e-signals.ts)
const SEED = `http://127.0.0.1:${process.env.API_PORT}/test/signals/evidence`;
/** The post of every seeded event (signals' createSignalEvent). */
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000009";
const messages: Record<string, string> = { ...contacts, ...signals, ...platform };

/** The text of a key with its values, its tags dropped; a key missing from the messages fails. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value
    .replace(/<\/?\w+>/g, "")
    .replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
}

/** The words of one case of a key's select, `{reaction, select, <value> {words} …}`. */
function chosen(key: string, value: string): string {
  const words = new RegExp(`[{\\s]${value} \\{([^{}]*)\\}`).exec(say(key))?.[1];
  if (words === undefined) throw new Error(`no case ${value} in ${key}`);
  return words;
}

const AUTHOR = "Evidence Two";
/** A Web research lead's page, company and reason (gamma-wr-061). */
const RESEARCH_PAGE = "https://frio-aurora.example/team";
const REASON_PAGE = "https://frio-aurora.example/";
/** A person found by the managers' search (gamma-wr-090): the company's site and the result's title. */
const SITE = "https://frio-austral.example/";
const MANAGER_TITLE = "Rafael Duarte - Diretor de Operações - Frio Austral | LinkedIn";
const COMPANY = "Frio Aurora Ltda";
const REASON_LINE = "Sells cold rooms to restaurants.";
const REASON_QUOTE = "vende câmaras frigoríficas para restaurantes";
const COMMENT = "Exactly our problem.";
const LEADS = [
  {
    ...{ slug: "e2e-evidence-two", firstName: "Evidence", lastName: "Two" },
    sources: ["Launch post", "Webinar post"],
    events: [
      {
        source: "Launch post",
        reaction: "like",
        author: AUTHOR,
        occurredAt: "2026-10-01T09:00:00.000Z",
      },
      {
        ...{ source: "Webinar post", reaction: "comment", commentText: COMMENT, author: AUTHOR },
        occurredAt: "2026-10-02T09:00:00.000Z",
      },
    ],
  },
  {
    ...{ slug: "e2e-evidence-imported", firstName: "Evidence", lastName: "Imported" },
    sources: ["imported"],
    events: [],
  },
  {
    ...{ slug: "e2e-evidence-reduced", firstName: "Evidence", lastName: "Reduced" },
    sources: ["Launch post"],
    events: [
      {
        ...{ source: "Launch post", reaction: "comment", author: "Evidence Reduced" },
        ...{ occurredAt: "2026-09-01T09:00:00.000Z", reduced: true },
      },
    ],
  },
  {
    ...{ slug: "e2e-evidence-research", firstName: "Evidence", lastName: "Research" },
    sources: ["Cold rooms"],
    events: [
      {
        source: "Cold rooms",
        occurredAt: "2026-10-03T09:00:00.000Z",
        research: {
          page: RESEARCH_PAGE,
          company: COMPANY,
          domain: "frio-aurora.example",
          reasons: [
            {
              ...{ kind: "focus", answer: "shown", line: REASON_LINE, quote: REASON_QUOTE },
              url: REASON_PAGE,
              readAt: "2026-10-03T08:00:00.000Z",
            },
          ],
        },
      },
    ],
  },
  {
    ...{ slug: "e2e-evidence-profile", firstName: "Evidence", lastName: "Profile" },
    sources: ["Cold rooms"],
    events: [
      {
        source: "Cold rooms",
        occurredAt: "2026-10-04T09:00:00.000Z",
        research: {
          ...{ page: RESEARCH_PAGE, company: "Frio Boreal Ltda", domain: "frio-boreal.example" },
          reasons: [],
          foundBy: "search",
        },
      },
    ],
  },
  {
    ...{ slug: "e2e-evidence-managers", firstName: "Evidence", lastName: "Managers" },
    sources: ["Cold rooms"],
    events: [
      {
        source: "Cold rooms",
        occurredAt: "2026-10-05T09:00:00.000Z",
        research: {
          ...{ page: SITE, company: "Frio Austral Ltda", domain: "frio-austral.example" },
          reasons: [],
          foundBy: "managers",
          title: MANAGER_TITLE,
        },
      },
    ],
  },
];

/** The workspace's leads, sources and events replaced with LEADS, without a session; the ids. */
async function seed(request: APIRequestContext): Promise<string[]> {
  const answer = await request.post(SEED, { data: { leads: LEADS } });
  expect(answer.status(), "the api on API_PORT must be serve:e2e").toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

const leadPath = (personId: string | undefined) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: say("signals.evidence.title") });

async function axe(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("a lead found by two sources: one line per event, newest first, with its source, the comment or the reaction and its author, the time and the post's link in a new tab; the attribution names the first source and the other; axe passes", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  const [two] = await seed(request);
  await page.goto(leadPath(two));
  const panel = panelOf(page);
  await expect(panel.locator("dt")).toHaveText([
    say("signals.evidence.first_source"),
    say("signals.evidence.other_sources"),
  ]);
  await expect(panel.locator("dd")).toHaveText(["Launch post", "Webinar post"]);
  const lines = panel.getByRole("listitem");
  await expect(lines.locator("strong")).toHaveText(["Webinar post", "Launch post"]);
  await expect(lines.nth(0)).toContainText(
    say("signals.evidence.comment", { author: AUTHOR, text: COMMENT }),
  );
  await expect(lines.nth(1)).toContainText(
    say("signals.evidence.reaction.like", { author: AUTHOR }),
  );
  const times = lines.locator("time");
  await expect(times).toHaveText([/^Oct 2, 2026, /, /^Oct 1, 2026, /]);
  expect(
    await times.evaluateAll((all) => all.map((time) => time.getAttribute("datetime"))),
  ).toEqual(["2026-10-02T09:00:00.000Z", "2026-10-01T09:00:00.000Z"]);
  const links = lines.getByRole("link", { name: say("signals.evidence.post") });
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", POST);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await axe(page);
});

test("an imported lead without an event shows the Imported label and no evidence list; a reduced event shows its summary, from the reaction and the date, and the post's link; axe passes", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  const [, imported, reduced] = await seed(request);
  await page.goto(leadPath(imported));
  const panel = panelOf(page);
  await expect(panel.getByText(say("signals.evidence.imported"), { exact: true })).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(panel.locator("dl")).toHaveCount(0);

  await page.goto(leadPath(reduced));
  const line = panel.getByRole("listitem");
  await expect(line.locator("strong")).toHaveText("Launch post");
  await expect(line).toContainText(
    `${chosen("signals.evidence.reduced", "comment")} on Sep 1, 2026`,
  );
  await expect(line.locator("time")).toHaveAttribute("datetime", "2026-09-01T09:00:00.000Z");
  await expect(line.getByRole("link", { name: say("signals.evidence.post") })).toHaveAttribute(
    "href",
    POST,
  );
  await axe(page);
});

test("a Web research lead shows its source, the page it was found on as a link in a new tab, and the company's reason with its quote and the page that holds it; no other person; axe passes, and at a phone's width nothing scrolls sideways", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  const research = (await seed(request))[3];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(leadPath(research));
  const panel = panelOf(page);
  await expect(panel.locator("dd")).toHaveText(["Cold rooms"]);
  const line = panel.getByRole("listitem");
  await expect(line.locator("strong")).toHaveText("Cold rooms");
  const found = say("signals.evidence.research.found", { source: "Cold rooms", company: COMPANY });
  await expect(line).toContainText(found.split(" · ")[1] ?? "");
  await expect(line.locator("time")).toHaveAttribute("datetime", "2026-10-03T09:00:00.000Z");
  await expect(line).toContainText(say("signals.evidence.research.reasons"));
  await expect(line).toContainText(REASON_LINE);
  await expect(line.locator("blockquote")).toHaveText(
    say("signals.evidence.research.quote", { quote: REASON_QUOTE }),
  );
  const pageLink = line.getByRole("link", { name: say("signals.evidence.page") });
  const reasonLink = line.getByRole("link", { name: say("signals.evidence.research.reason_page") });
  for (const [link, href] of [
    [pageLink, RESEARCH_PAGE],
    [reasonLink, REASON_PAGE],
  ] as const) {
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // The post's link of the LinkedIn kinds is not here.
  await expect(line.getByRole("link", { name: say("signals.evidence.post") })).toHaveCount(0);
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(wide, "the page scrolls sideways at 390 px").toBe(false);
  await axe(page);
});

test("a Web research lead whose profile was found by a search says so, and one found on the page does not", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  const ids = await seed(request);
  const words = say("signals.evidence.research.profile_by_search");
  await page.goto(leadPath(ids[4]));
  await expect(panelOf(page).getByRole("listitem")).toContainText(words);
  await page.goto(leadPath(ids[3]));
  await expect(panelOf(page).getByRole("listitem")).not.toContainText(words);
});

test("a Web research lead found by the managers' search says so, with the result's title and the company's site as its link in a new tab, and can be checked before it is approved; a lead found on a page shows neither", async ({
  page,
  request,
  signInAs,
}) => {
  await signInAs();
  const ids = await seed(request);
  await page.goto(leadPath(ids[5]));
  const line = panelOf(page).getByRole("listitem");
  const found = say("signals.evidence.research.found_by_managers", {
    source: "Cold rooms",
    company: "Frio Austral Ltda",
  });
  await expect(line).toContainText(found.split(" · ")[1] ?? "");
  await expect(line).toContainText(say("signals.evidence.research.managers_by_search"));
  await expect(line).toContainText(
    say("signals.evidence.research.managers_title", { title: MANAGER_TITLE }),
  );
  const site = line.getByRole("link", { name: say("signals.evidence.research.company_site") });
  await expect(site).toHaveAttribute("href", SITE);
  await expect(site).toHaveAttribute("target", "_blank");
  await expect(site).toHaveAttribute("rel", "noopener noreferrer");
  await expect(line.getByRole("link", { name: say("signals.evidence.page") })).toHaveCount(0);
  await axe(page);
  await page.goto(leadPath(ids[3]));
  await expect(panelOf(page).getByRole("listitem")).not.toContainText(
    say("signals.evidence.research.managers_by_search"),
  );
});

test("a panel that throws shows the slot's message and the code in words, and the page and the other slots stay up", async ({
  page,
  context,
  request,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [two] = await seed(request);
  await context.addCookies([{ name: "fixture_panel", value: "throw", url: baseURL ?? "" }]);
  await page.goto(leadPath(two));
  const slot = (name: string) => page.locator(`[data-slot="${name}"]`);
  await expect(slot("draft").locator("p").first()).toHaveText(say("contacts.lead.slot_failed"));
  // A panel's own error has no api code: the generic words (contacts-states.spec.ts retries it).
  await expect(slot("draft").getByRole("alert")).toContainText(say("platform.error.generic"));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Evidence Two");
  await expect(panelOf(page).getByRole("listitem")).toHaveCount(2);
  const review = page.getByRole("region", { name: say("contacts.review.title"), exact: true });
  await expect(review).toBeVisible();
  await expect(slot("actions")).not.toBeEmpty();
});
