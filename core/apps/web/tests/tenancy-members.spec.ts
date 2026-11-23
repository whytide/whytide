// tenancy's members screen end to end (gamma-p6-030; core/modules/tenancy/README.md "Members"), in
// wsp_e2e_members, this spec's alone, whose E2E_USERS are Owners (core/apps/api/tests/e2e-server.ts)
// and whose two Members the e2e api's test-only module makes active again before each test: an
// Owner makes a Member an Owner and back, reads a refused change and a refused removal in words,
// removes a member after the confirmation, which says what the member leaves, and has the link to
// the invites; a Member reads the list, "You" on their row, with no role menu, Remove or link. Every
// text from its key; axe on both views.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import tenancy from "../../../modules/tenancy/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { E2E_EMAIL, expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_members";
const MIA = { email: "e2e-members-mia@example.com", displayName: "Mia Member", role: "Member" };
const REMY = { email: "e2e-members-remy@example.com", displayName: "Remy Remove", role: "Member" };
const SCREEN = `/w/${WORKSPACE}/members`;
const messages: Record<string, string> = { ...tenancy, ...ui, ...web };

/** The text of a key, its `{name}` placeholders filled; a key missing from the messages fails. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** No serious or critical axe violation on the page as it stands. */
async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const rowOf = (page: Page, text: string) =>
  page.getByRole("main").getByRole("listitem").filter({ hasText: text });
/** The screen's alerts: Next's route announcer is one too, outside main. */
const alertOf = (page: Page) => page.getByRole("main").getByRole("alert");
const roleMenu = (page: Page, name: string) =>
  page.getByRole("combobox", { name: say("tenancy.members.role.label", { name }) });
const removeButton = (page: Page, name: string) =>
  page.getByRole("button", { name: say("tenancy.members.remove.label", { name }) });

test.beforeEach(async ({ page, signInAs, baseURL }) => {
  await signInAs();
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/members`, {
    data: { members: [MIA, REMY] },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
});

test("an Owner changes a role and back, reads a refusal in words, removes a member after the confirmation, and has the invites", async ({
  page,
}) => {
  test.slow(); // three page loads, four changes and two axe runs
  await page.goto(SCREEN);
  await expect(
    page.getByRole("heading", { level: 1, name: say("tenancy.members.title") }),
  ).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: say("web.nav.company") });
  const link = group.getByRole("link", { name: say("tenancy.nav.members") });
  await expect(link).toHaveAttribute("href", SCREEN);
  const own = rowOf(page, E2E_EMAIL);
  await expect(own.getByText(say("tenancy.members.you"))).toBeVisible();
  await expect(own.getByRole("combobox")).toHaveCount(0);
  await expect(own.getByRole("button")).toHaveCount(0);
  await expect(rowOf(page, MIA.displayName).getByText(MIA.email)).toBeVisible();
  const invites = page.getByRole("link", { name: say("tenancy.members.invite") });
  await expect(invites).toHaveAttribute("href", `/w/${WORKSPACE}/invites`);
  await expectAccessible(page);

  const patched = () =>
    page.waitForResponse(
      (answer) =>
        answer.request().method() === "PATCH" && answer.url().includes("/tenancy/members/"),
    );
  const promoted = patched();
  await roleMenu(page, MIA.displayName).selectOption("Owner");
  expect((await promoted).status()).toBe(200);
  await page.reload();
  await expect(roleMenu(page, MIA.displayName)).toHaveValue("Owner");
  const demoted = patched();
  await roleMenu(page, MIA.displayName).selectOption("Member");
  expect((await demoted).status()).toBe(200);
  await page.reload();
  await expect(roleMenu(page, MIA.displayName)).toHaveValue("Member");

  // last_owner and member_is_self cannot come from these rows: the API's answer stands in for them.
  await page.route("**/tenancy/members/*", (route) => {
    const method = route.request().method();
    if (method === "PATCH") return route.fulfill({ status: 409, json: { code: "last_owner" } });
    if (method === "DELETE")
      return route.fulfill({ status: 409, json: { code: "member_is_self" } });
    return route.fallback();
  });
  await roleMenu(page, MIA.displayName).selectOption("Owner");
  await expect(alertOf(page)).toContainText(say("tenancy.errors.last_owner"));
  await expect(roleMenu(page, MIA.displayName)).toHaveValue("Member");
  await removeButton(page, MIA.displayName).click();
  const confirmMia = page.getByRole("dialog", {
    name: say("tenancy.members.remove.title", { name: MIA.displayName }),
  });
  await confirmMia.getByRole("button", { name: say("tenancy.members.remove.action") }).click();
  await expect(alertOf(page)).toContainText(say("tenancy.errors.member_is_self"));
  await expect(rowOf(page, MIA.displayName)).toHaveCount(1);
  await page.unroute("**/tenancy/members/*");

  await removeButton(page, REMY.displayName).click();
  const confirm = page.getByRole("dialog", {
    name: say("tenancy.members.remove.title", { name: REMY.displayName }),
  });
  for (const key of ["linkedin", "mailbox", "agents", "campaigns"]) {
    await expect(confirm.getByText(say(`tenancy.members.remove.${key}`))).toBeVisible();
  }
  await expectAccessible(page);
  await confirm.getByRole("button", { name: say("tenancy.members.remove.action") }).click();
  await expect(rowOf(page, REMY.displayName)).toHaveCount(0);
  await expect(alertOf(page)).toHaveCount(0);
  await page.reload();
  await expect(rowOf(page, MIA.displayName)).toHaveCount(1);
  await expect(rowOf(page, REMY.displayName)).toHaveCount(0);
});

test("a Member reads the list, their own row marked, with no role menu, no Remove and no invites", async ({
  page,
  signInAs,
}) => {
  await signInAs(MIA.email);
  await page.goto(SCREEN);
  await expect(rowOf(page, MIA.displayName).getByText(say("tenancy.members.you"))).toBeVisible();
  await expect(rowOf(page, REMY.displayName)).toHaveCount(1);
  await expect(
    rowOf(page, E2E_EMAIL).getByText(say("tenancy.members.role.owner"), { exact: true }),
  ).toBeVisible();
  await expect(
    rowOf(page, REMY.displayName).getByText(say("tenancy.members.role.member"), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("listitem").getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("link", { name: say("tenancy.members.invite") })).toHaveCount(0);
  await expectAccessible(page);
});
