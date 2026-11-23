// Every screen at a phone's width, 390×844 (ui-tailwind, from !155's review): nothing wider than the
// phone, so that nothing scrolls sideways or is cut off at the edge. The document's width, and main's
// and each of its ancestors': the shell's panel scrolls inside the window, so a screen wider than it
// leaves the document's width alone. The public pages signed out; the workspace's screens in
// wsp_e2e_phone, this spec's alone (core/apps/api/tests/e2e-server.ts), with one lead titled by a
// long LinkedIn URL, as a lead without a name is.
import type { Page } from "@playwright/test";
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_phone";
/** A profile's slug without a hyphen: the lead's title, its URL, can wrap nowhere but inside. */
const SLUG = `phone${"x".repeat(55)}`;
const PUBLIC = ["/sign-in", "/sign-in/sent", "/sign-in/expired", "/email/callback", "/invitations"];
const SCREENS = [
  "leads",
  "campaigns",
  "up-next",
  "inbox",
  "never-contact",
  "company",
  "members",
  "invites",
  "icp",
  "agents",
  "sources",
  "companies-found",
  "import",
  "linkedin",
  "mailboxes",
  "counts",
  "results",
  "health",
  "credits",
];

test.use({ viewport: { width: 390, height: 844 } });

/** What is wider than the phone: the document, main or an ancestor of main, with its width. */
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

/** The screen opened, its title shown and its reads answered: then nothing may be wider. */
async function expectFits(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page), path).toEqual([]);
}

test("the public pages fit a phone's width", async ({ page }) => {
  for (const path of PUBLIC) await expectFits(page, path);
});

test("each workspace screen fits a phone's width, a lead titled by a long LinkedIn URL among them", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [{ slug: SLUG, source: "imported" }] },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const [lead] = ((await answer.json()) as { personIds: string[] }).personIds;
  for (const screen of [...SCREENS, `leads/${lead}`]) {
    await expectFits(page, `/w/${WORKSPACE}/${screen}`);
  }
});
