// qualification's Re-score on the lead page (lead-rescore-ai; core/modules/qualification/README.md
// "Screen", "A new assessment") end to end on the e2e api, in wsp_e2e_rescore, this spec's alone.
// Every decided lead has it with its line, one the hard filters stopped and one the AI failed too.
// The press asks the AI again: the lead waits as pending, and the panel reads it, busy, until it
// leaves pending. The e2e api runs no worker: its test-only module (core/apps/api/tests/fixtures/e2e)
// writes the decision the batch would, then the panel says its status and the page shows the
// decision; a batch out of credits leaves the lead waiting, whose note the page then shows. A pending
// lead a member asked for has its note instead. Axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_rescore";
const messages: Record<string, string> = { ...contacts, ...qualification, ...ui };
/** The panel reads the lead every three seconds: a new status shows within one read or two. */
const READ = { timeout: 15_000 };

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

const person = (slug: string) => ({
  slug: `e2e-rescore-${slug}`,
  firstName: "Rescore",
  lastName: "Lead",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
});
/** The lead qualified with this fit, its snapshot scored the same: what the batch writes. */
function qualified(fitScore: number) {
  const decision = {
    status: "qualified",
    fitScore,
    confidence: "high",
    tier: "warm",
    icpVersion: 1,
  };
  const snapshot = { ...decision, summary: "Runs a data team.", disqualifiers: [], verdicts: [] };
  return { ...person("lead"), decision, snapshot };
}
const filtered = {
  ...person("lead"),
  decision: { status: "hard_filtered", reason: "country_mismatch", icpVersion: 1 },
};

/** Replaces the workspace's leads with these, through the e2e api's test-only route; their ids. */
async function seed(page: Page, origin: string | undefined, leads: object[]) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

const panelOf = (page: Page) => page.locator('[data-slot="actions"]');
const rescoreOf = (page: Page) =>
  panelOf(page).getByRole("button", { name: say("qualification.action.rescore") });

test("Re-score asks the AI again for a lead the hard filters stopped: busy while it waits, then its new status shows and the page shows its decision; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [id] = await seed(page, baseURL, [filtered]);
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  await expect(rescoreOf(page)).toBeVisible();
  await expect(panelOf(page).getByText(say("qualification.action.rescore_hint"))).toBeVisible();
  await expectNoSeriousViolation(page);

  const answer = page.waitForResponse("**/qualification/leads/*/reassess");
  await rescoreOf(page).click();
  expect((await answer).status()).toBe(202);
  expect(await (await answer).json()).toEqual({ status: "pending", requested: true });
  const status = panelOf(page).getByRole("status");
  await expect(status).toHaveText(say("ui.state.loading"));
  await expect(rescoreOf(page)).toHaveAttribute("aria-busy", "true");
  // The batch's part: the AI's decision, which the lead takes; the same person.
  expect(await seed(page, baseURL, [qualified(74)])).toEqual([id]);
  await expect(status).toHaveText("Re-scored: qualified.", READ);
  const decision = page.getByRole("region", { name: say("contacts.lead.qualification") });
  await expect(decision.locator("dd").nth(1)).toHaveText("74");
  await expect(rescoreOf(page)).not.toHaveAttribute("aria-busy");
  await expectNoSeriousViolation(page);
});

test("a press the batch leaves waiting for credits stops the reads: the page shows the lead's note and no Re-score", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [id] = await seed(page, baseURL, [filtered]);
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  const answer = page.waitForResponse("**/qualification/leads/*/reassess");
  await rescoreOf(page).click();
  expect((await answer).status()).toBe(202);
  // The batch's part: no credits left, so the lead waits for a top-up.
  const credits = { status: "pending", reason: "insufficient_credits" };
  expect(await seed(page, baseURL, [{ ...person("lead"), decision: credits }])).toEqual([id]);
  const note = "Waiting for credits: the next batch after a top-up assesses it.";
  await expect(panelOf(page)).toHaveText(note, READ);
  await expect(panelOf(page).getByRole("button")).toHaveCount(0);
});

test("an ai_failed lead has Re-score with why the AI failed; a pending lead a member asked for has its note and no Re-score", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const failed = {
    ...person("failed"),
    decision: { status: "ai_failed", reason: "provider_failed", icpVersion: 1 },
  };
  const asked = { ...person("asked"), decision: { status: "pending", reason: "member_requested" } };
  const [failedId, askedId] = await seed(page, baseURL, [failed, asked]);

  await page.goto(`/w/${WORKSPACE}/leads/${failedId}`);
  await expect(rescoreOf(page)).toBeVisible();
  await expect(panelOf(page).getByText(say("qualification.action.rescore_hint"))).toBeVisible();
  const why = "The model’s provider failed three times. Re-score asks the AI again.";
  await expect(panelOf(page).getByText(why)).toBeVisible();

  await page.goto(`/w/${WORKSPACE}/leads/${askedId}`);
  await expect(panelOf(page)).toHaveText(
    "Asked for by a member: the AI assesses it again in a few minutes.",
  );
  await expect(panelOf(page).getByRole("button")).toHaveCount(0);
  await expectNoSeriousViolation(page);
});
