// qualification's Re-score on the lead page (alpha-p10-100; core/modules/qualification/README.md
// "Screen") end to end on the e2e api, in wsp_e2e_rescore, this spec's alone. The request marks a
// lead scored at the ICP's version by other criteria, and the panel waits for a new snapshot. The
// e2e api runs no worker: its test-only module (core/apps/api/tests/fixtures/e2e) writes the
// snapshot the worker's re-score would, then the panel says its status and the page shows its
// decision. A lead scored at another ICP version is marked by none, which the panel says. Axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import qualification from "../../../modules/qualification/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_rescore";
const messages: Record<string, string> = { ...contacts, ...qualification, ...ui };

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

/** The one lead, qualified with this fit at this ICP version, its snapshot scored the same. */
function leadWith(fitScore: number, icpVersion = 1) {
  const decision = { status: "qualified", fitScore, confidence: "high", tier: "warm", icpVersion };
  return {
    slug: "e2e-rescore-lead",
    firstName: "Rescore",
    lastName: "Lead",
    title: "Head of Data",
    companyName: "Blue Harbor Labs",
    source: "imported",
    decision,
    snapshot: { ...decision, summary: "Runs a data team.", disqualifiers: [], verdicts: [] },
  };
}

/** Replaces the workspace's leads with this one, through the e2e api's test-only route; its id. */
async function seed(page: Page, origin: string | undefined, lead: ReturnType<typeof leadWith>) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [lead] },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: [string] }).personIds[0];
}

const rescoreOf = (page: Page) =>
  page.locator('[data-slot="actions"]').getByRole("button", {
    name: say("qualification.action.rescore"),
  });

test("Re-score marks the lead and waits; the new snapshot's status shows and the page shows its decision; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const id = await seed(page, baseURL, leadWith(64));
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  const decision = page.getByRole("region", { name: say("contacts.lead.qualification") });
  await expect(decision.locator("dd").nth(1)).toHaveText("64");
  await expectNoSeriousViolation(page);

  const answer = page.waitForResponse("**/qualification/rescore");
  await rescoreOf(page).click();
  expect((await answer).status()).toBe(202);
  expect(await (await answer).json()).toMatchObject({ marked: 1 });
  const status = page.locator('[data-slot="actions"]').getByRole("status");
  await expect(status).toHaveText(say("ui.state.loading"));
  // The worker's part: a new snapshot, scored, which takes the lead; the same person.
  expect(await seed(page, baseURL, leadWith(74))).toBe(id);
  await expect(status).toHaveText("Re-scored: qualified.");
  await expect(decision.locator("dd").nth(1)).toHaveText("74");
  await expect(rescoreOf(page)).not.toHaveAttribute("aria-busy");
  await expectNoSeriousViolation(page);
});

test("a lead scored at another ICP version is marked by none, which the panel says", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  // A fresh workspace's ICP is at version 1.
  const id = await seed(page, baseURL, leadWith(64, 2));
  await page.goto(`/w/${WORKSPACE}/leads/${id}`);
  const answer = page.waitForResponse("**/qualification/rescore");
  await rescoreOf(page).click();
  expect(await (await answer).json()).toMatchObject({ marked: 0 });
  await expect(page.locator('[data-slot="actions"]').getByRole("status")).toHaveText(
    say("qualification.action.unchanged"),
  );
});
