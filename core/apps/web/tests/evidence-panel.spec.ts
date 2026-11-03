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
