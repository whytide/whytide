// The host's end-to-end flows (alpha-p2-040), on the test module of tests/fixtures/modules/: its
// screen in the navigation with the api's data, the same data through the /api rewrite, a screen
// that throws, and the not-found page; the pages under the content security policy, with no
// violation.
import type { Page } from "@playwright/test";
import web from "../messages/en.json" with { type: "json" };
import fixture from "./fixtures/modules/fixture/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const messages: Record<string, string> = { ...web, ...fixture };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

function cspViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) seen.push(message.text());
  });
  return seen;
}

test("the fixture screen sits in its group and shows the api's data", async ({
  page,
  signInAs,
}) => {
  const violations = cspViolations(page);
  await signInAs();
  const answer = await page.goto(`/w/${WORKSPACE}/fixture?name=ada`);
  expect(answer?.headers()["content-security-policy"]).toContain("'nonce-");
  const group = page.getByRole("navigation").getByRole("list", { name: say("web.nav.company") });
  const link = group.getByRole("link", { name: say("fixture.nav.greeting") });
  await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/fixture`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("fixture.greeting.title"));
  await expect(page.getByText("The api says hello to ada.")).toBeVisible();
  const viaRewrite = await page.request.get(`/api/v1/workspaces/${WORKSPACE}/fixture/ada`);
  expect(await viaRewrite.json()).toEqual({ name: "ada", greeting: "hello" });
  expect(violations).toEqual([]);
});

test("a screen that throws shows ErrorState with the code in words", async ({ page, signInAs }) => {
  const violations = cspViolations(page);
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/fixture?name=missing`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("web.error.title"));
  const alert = page.getByRole("main").getByRole("alert"); // Next's route announcer is an alert too
  await expect(alert).toContainText(say("fixture.errors.fixture_not_found"));
  expect(violations).toEqual([]);
});

test("an address no route takes shows the not-found page", async ({ page }) => {
  const answer = await page.goto(`/w/${WORKSPACE}/nope`);
  expect(answer?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(say("web.not_found.title"));
  await expect(page.getByText(say("web.not_found.body"))).toBeVisible();
});
