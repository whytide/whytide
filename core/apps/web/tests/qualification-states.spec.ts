// qualification's panel on the lead page (alpha-p10-100; core/modules/qualification/README.md
// "Screen"), in its actions slot, on leads that the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e) in wsp_e2e_qual, this spec's alone. A lead with no scored
// assessment is the empty state, which says what comes next, with no Re-score: pending with no
// reason or for credits, ai_failed after the provider's three failures or for its answer. A
// needs_review lead says what to check, with Re-score. A failed request, through Playwright's
// routing, is the error state, whose retry asks again and waits. Axe on each.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_qual";
const messages: Record<string, string> = { ...qualification, ...platform, ...ui };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const person = (slug: string, lastName: string) => ({
  slug: `e2e-qual-${slug}`,
  firstName: "Qual",
  lastName,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
});
const review = {
  status: "needs_review",
  fitScore: 61,
  confidence: "low",
  tier: "warm",
  icpVersion: 1,
};
const LEADS = [
  person("new", "New"),
  {
    ...person("credits", "Credits"),
    decision: { status: "pending", reason: "insufficient_credits" },
  },
  {
    ...person("provider", "Provider"),
    decision: { status: "ai_failed", reason: "provider_failed" },
  },
  { ...person("answer", "Answer"), decision: { status: "ai_failed", reason: "length" } },
  {
    ...person("review", "Review"),
    decision: review,
    snapshot: { ...review, summary: "Runs a data team.", disqualifiers: [], verdicts: [] },
  },
] as const;
const AGAIN =
  "A re-score needs an assessment: after a change to the ICP’s targeting, the next batch assesses it again.";

/** Replaces the workspace's leads with these, through the e2e api's test-only route; their ids. */
async function seed(page: Page, origin: string | undefined) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: LEADS },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

const panelOf = (page: Page) => page.locator('[data-slot="actions"]');

test("a lead with no scored assessment is the empty state, which says what comes next, with no Re-score; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const ids = await seed(page, baseURL);
  const said = [
    "Not assessed yet: the next batch assesses it.",
    "Waiting for credits: the next batch after a top-up assesses it.",
    `The model’s provider failed three times. ${AGAIN}`,
    `The model’s answer could not be used. ${AGAIN}`,
  ];
  for (const [index, text] of said.entries()) {
    await page.goto(`/w/${WORKSPACE}/leads/${ids[index]}`);
    await expect(panelOf(page)).toHaveText(text);
    await expect(panelOf(page).getByRole("button")).toHaveCount(0);
  }
  await expectNoSeriousViolation(page);
});

test("a needs_review lead says what to check before Re-score; a failed request is the error state, whose retry asks again and waits; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const ids = await seed(page, baseURL);
  await page.goto(`/w/${WORKSPACE}/leads/${ids[4]}`);
  const panel = panelOf(page);
  await expect(panel.locator("p")).toHaveText(say("qualification.explain.needs_review"));
  const rescore = panel.getByRole("button", { name: say("qualification.action.rescore") });
  await expectNoSeriousViolation(page);

  let calls = 0;
  await page.route("**/qualification/rescore", async (route) => {
    calls += 1;
    if (calls > 1) return route.fallback();
    await route.fulfill({ status: 500, json: { code: "internal_error" } });
  });
  await rescore.click();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText(say("ui.state.error"));
  await expect(alert).toContainText(say("platform.error.generic"));
  await expectNoSeriousViolation(page);

  const answer = page.waitForResponse("**/qualification/rescore");
  await alert.getByRole("button", { name: say("ui.action.retry") }).click();
  expect((await answer).status()).toBe(202);
  expect(await (await answer).json()).toMatchObject({ marked: 1 });
  // No worker runs here: the panel waits for a new snapshot, busy.
  await expect(panel.getByRole("status")).toHaveText(say("ui.state.loading"));
  await expect(rescore).toHaveAttribute("aria-busy", "true");
  expect(calls).toBe(2);
});
