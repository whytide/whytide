// contacts' review panel in the lead page's review slot, and the list's review column and filter
// (alpha-p9-040; core/modules/contacts/README.md "Screens"), on leads that the e2e api's test-only
// module writes (core/apps/api/tests/fixtures/e2e) in the e2e users' review workspace, whose leads
// are this spec's alone: Not a fit, a reason and Confirm show the decision, latest and in the
// history, without a reload; the list's column shows it and its filter leaves the lead out, as do
// the lead page's previous and next; axe.
import { AxeBuilder } from "@axe-core/playwright";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_review";
const messages: Record<string, string> = contacts;

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const lead = (slug: string, fitScore: number) => ({
  slug: `e2e-review-${slug}`,
  firstName: "Review",
  lastName: slug,
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  source: "imported",
  decision: { status: "qualified", fitScore, confidence: "high", tier: "hot" },
});

test("on the lead page, Not a fit, a reason and Confirm show the decision, latest and in the history, without a reload; the list's review column shows it and its filter leaves the lead out, as do previous and next; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const leads = [lead("first", 90), lead("second", 80), lead("third", 70)];
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const { personIds } = (await answer.json()) as { personIds: [string, string, string] };
  const [first, second, third] = personIds;

  await page.goto(`/w/${WORKSPACE}/leads/${second}`);
  const panel = page.getByRole("region", { name: say("contacts.review.title"), exact: true });
  await expect(panel.locator("dd")).toHaveText(say("contacts.review.none"));
  // A mark on the page that a reload would lose.
  await page.evaluate(() => Object.assign(window, { kept: true }));
  const notAFit = panel.getByRole("button", { name: say("contacts.review.not_a_fit") });
  const confirm = panel.getByRole("button", { name: say("contacts.review.confirm") });
  // A click before the page hydrates is lost: again until the form answers.
  await expect(async () => {
    await notAFit.click();
    await expect(confirm).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await confirm.click();
  const required = say("contacts.errors.review_reason_required");
  await expect(panel.getByText(required, { exact: true })).toBeVisible();
  const reasons = panel.getByLabel(say("contacts.review.reason"), { exact: true });
  await reasons.selectOption("company_wrong_size");
  await confirm.click();
  const reason = say("contacts.review.code.company_wrong_size");
  const decided = say("contacts.review.not_a_fit_because").replace("{reason}", reason);
  await expect(panel.locator("dd strong")).toHaveText(decided);
  await expect(panel.getByRole("listitem").locator("strong")).toHaveText([decided]);
  await expect(confirm).toHaveCount(0);
  expect(await page.evaluate(() => "kept" in window)).toBe(true);

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  await page.goto(`/w/${WORKSPACE}/leads`);
  const rows = page.locator("tbody tr");
  // Not a fit, and its reason on hover and for a screen reader; the review column is before
  // Outreach and the row menu's.
  const review = rows.locator("td:nth-last-child(3)");
  await expect(review).toHaveText(["", new RegExp(`^${say("contacts.review.not_a_fit")}`), ""]);
  await expect(review.locator("span[title]")).toHaveAttribute("title", decided);
  // React replays a change made before hydration.
  await page.getByLabel(say("contacts.leads.filter.review"), { exact: true }).check();
  await expect(rows).toHaveCount(2);
  await expect(page.locator("[aria-busy]")).toHaveCount(0);
  const view = "?status=qualified&sort=fit&review=unreviewed";
  const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}${view}`;
  const links = rows.getByRole("link");
  const hrefs = await links.evaluateAll((all) => all.map((link) => link.getAttribute("href")));
  expect(hrefs).toEqual([first, third].map(leadPath));
  await links.first().click();
  await page.waitForURL((url) => `${url.pathname}${url.search}` === leadPath(first));
  const around = page.getByRole("navigation", { name: say("contacts.lead.navigation") });
  await expect(around.getByRole("link", { name: say("contacts.lead.next") })).toHaveAttribute(
    "href",
    leadPath(third),
  );
});
