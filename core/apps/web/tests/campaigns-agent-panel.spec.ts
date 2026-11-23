// campaigns' panel on playbooks' agent page end to end (gamma-p3-065; core/modules/campaigns/README.md
// "Screens"), in wsp_e2e_agent_campaign, this spec's alone, whose E2E_USERS are Owners
// (core/apps/api/tests/e2e-server.ts). Each test first has the e2e api's test-only module remove the
// workspace's agents (POST …/e2e/agents), makes an agent on the default audience through playbooks'
// route, then, as the e2e api runs no worker, has the e2e module make the agent's campaign as
// campaigns' subscriber to playbooks.playbook_created does (POST …/e2e/agent-campaign). A draft: its
// name, status, version, its seven steps read only and the note that it sends nothing, with no Pause
// and the way to the campaign's page; an active one: Pause behind its Dialog, then Resume, through
// campaigns' routes, the agent's own status left as it was; no campaign yet, the empty state; the
// page at a phone's width; for a Member, made by the e2e module, another member's campaign without
// Pause, the hint in its place, and her own with it (gamma-p6-015). Every text from its key; axe on
// each view.
import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { APIResponse, Locator, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import campaigns from "../../../modules/campaigns/messages/en.json" with { type: "json" };
import playbooks from "../../../modules/playbooks/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_agent_campaign";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const NAME = "Warm leads in fintech";
const PHONE = { width: 390, height: 844 };
/** A Member of the workspace, made through the e2e module's members route. */
const MEMBER = { email: "e2e-panel-member@example.com", displayName: null, role: "Member" };
/** The warm-signal default's steps, in order (domain/template/warm-signal.ts). */
const WARM = [
  "connect",
  "message_1",
  "follow_up_1",
  "follow_up_2",
  "email_1",
  "email_2",
  "email_3",
];

type Translate = (key: string, values?: Record<string, string | number>) => string;

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
  messages: nest({ ...campaigns, ...playbooks, ...ui, ...web }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;

/** No serious or critical axe violation on the page as it stands. */
async function expectAccessible(page: Page) {
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

/** The routes the tests stand on, as the signed-in user, through the web's /api rewrite. */
function apiOf(page: Page, origin: string) {
  const headers = { origin };
  const ok = async (answer: APIResponse, status = 200) => {
    expect(answer.status(), await answer.text()).toBe(status);
    return answer.json();
  };
  return {
    /** No agent, the default audience alone, then an agent on it through playbooks' route: its id. */
    agent: async (name: string): Promise<string> => {
      await ok(await page.request.post(`${API}/e2e/agents`, { data: { sources: [] }, headers }));
      const read = await ok(await page.request.get(`${API}/icp/audiences`, { headers }));
      const { audiences } = read as { audiences: { id: string; isDefault: boolean }[] };
      const icpId = audiences.find(({ isDefault }) => isDefault)?.id ?? "";
      const answer = await page.request.post(`${API}/playbooks`, {
        data: { name, icpId },
        headers: { ...headers, "idempotency-key": randomUUID() },
      });
      return ((await ok(answer, 201)) as { id: string }).id;
    },
    /** The agent's campaign, as the worker's delivery makes it, active if asked: its id. */
    campaign: async (playbookId: string, active: boolean): Promise<string> => {
      const data = { playbookId, active };
      const answer = await page.request.post(`${API}/e2e/agent-campaign`, { data, headers });
      return ((await ok(answer)) as { campaignId: string }).campaignId;
    },
    /** The Member, made a member of the workspace through the e2e module. */
    member: async (): Promise<void> => {
      const data = { members: [MEMBER] };
      await ok(await page.request.post(`${API}/e2e/members`, { data, headers }));
    },
    status: async (campaignId: string): Promise<string> =>
      ((await ok(await page.request.get(`${API}/campaigns/${campaignId}`))) as { status: string })
        .status,
  };
}

/** The agent's page, and the campaign's panel on it. */
async function panelOf(page: Page, playbookId: string): Promise<Locator> {
  await page.goto(`/w/${WORKSPACE}/agents/${playbookId}`);
  await expect(page.getByRole("heading", { level: 1, name: NAME })).toBeVisible();
  return page.getByRole("region", { name: t("campaigns.agent_panel.title") });
}

test("a draft: its name, status, version and seven steps, read only, the note that it sends nothing, no Pause, and the way to its page", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const playbookId = await api.agent(NAME);
  const campaignId = await api.campaign(playbookId, false);
  const panel = await panelOf(page, playbookId);
  await expect(panel.getByText(NAME, { exact: true })).toBeVisible();
  await expect(panel.getByText(t("campaigns.list.status.draft"), { exact: true })).toBeVisible();
  await expect(panel.getByText(t("campaigns.list.version", { version: 1 }))).toBeVisible();
  await expect(panel.getByText(t("campaigns.agent_panel.not_launched"))).toBeVisible();
  await expect(panel.getByText(t("campaigns.agent_panel.draft_note"))).toBeVisible();
  const steps = panel.getByRole("listitem");
  await expect(steps).toHaveCount(WARM.length);
  for (const [index, key] of WARM.entries()) {
    await expect(steps.nth(index)).toContainText(t(`campaigns.editor.step.${key}`));
  }
  await expect(steps.first()).toContainText(t("campaigns.editor.at_enrollment"));
  await expect(steps.last()).toContainText(t("campaigns.agent_panel.fallback"));
  // Read only: no field, and a draft is neither paused nor resumed here.
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("link", { name: t("campaigns.agent_panel.open") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/campaigns/${campaignId}`,
  );
  await expectAccessible(page);
});

test("an active campaign: Pause asks first, then Resume, through campaigns' routes, the agent's own status left as it was", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // a page load, a pause, a resume and two axe runs
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const playbookId = await api.agent(NAME);
  const campaignId = await api.campaign(playbookId, true);
  const panel = await panelOf(page, playbookId);
  const status = (key: string) =>
    panel.getByText(t(`campaigns.list.status.${key}`), { exact: true });
  await expect(status("active")).toBeVisible();
  await expect(panel.getByText(t("campaigns.agent_panel.not_launched"))).toHaveCount(0);
  await expect(panel.getByText(t("campaigns.agent_panel.draft_note"))).toHaveCount(0);
  const pause = t("campaigns.agent_panel.pause");
  await panel.getByRole("button", { name: pause, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: t("campaigns.agent_panel.pause_title") });
  await expect(dialog.getByText(t("campaigns.agent_panel.pause_body"))).toBeVisible();
  // The dialog pops in from transparent (the kit's animation): axe reads it once opaque.
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  await dialog.getByRole("button", { name: pause, exact: true }).click();
  await expect(status("paused")).toBeVisible();
  expect(await api.status(campaignId)).toBe("paused");
  const resume = panel.getByRole("button", { name: t("campaigns.agent_panel.resume") });
  await resume.click();
  await expect(status("active")).toBeVisible();
  expect(await api.status(campaignId)).toBe("active");
  // The agent itself is still active: its own Pause, outside the panel, is offered.
  const agentPause = page.getByRole("button", { name: t("playbooks.agent.pause"), exact: true });
  await expect(agentPause).toBeVisible();
  await expectAccessible(page);
});

test("no campaign yet: the empty state; with one, the page fits a phone's width", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const playbookId = await api.agent(NAME);
  const panel = await panelOf(page, playbookId);
  await expect(panel.getByText(t("campaigns.agent_panel.empty"))).toBeVisible();
  await expectAccessible(page);

  await api.campaign(playbookId, true);
  await page.setViewportSize(PHONE);
  await panelOf(page, playbookId);
  await expect(panel.getByRole("listitem")).toHaveCount(WARM.length);
  await page.waitForLoadState("networkidle");
  expect(await overflows(page)).toEqual([]);
});

test("a Member on another member's agent: its active campaign without Pause, the hint in its place; on her own agent's, Pause and no hint", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const theirs = await api.agent(NAME);
  await api.campaign(theirs, true);
  await api.member();
  await signInAs(MEMBER.email);
  const panel = await panelOf(page, theirs);
  const hint = panel.getByText(t("campaigns.editor.not_owner"));
  await expect(panel.getByText(t("campaigns.list.status.active"), { exact: true })).toBeVisible();
  await expect(hint).toBeVisible();
  await expect(panel.getByRole("button")).toHaveCount(0);
  await expect(panel.getByRole("link", { name: t("campaigns.agent_panel.open") })).toBeVisible();
  await expectAccessible(page);

  // Her agent, made through playbooks' route as she is signed in: its campaign is hers.
  const hers = await api.agent(NAME);
  await api.campaign(hers, true);
  await panelOf(page, hers);
  const pause = panel.getByRole("button", { name: t("campaigns.agent_panel.pause"), exact: true });
  await expect(pause).toBeVisible();
  await expect(hint).toHaveCount(0);
});
