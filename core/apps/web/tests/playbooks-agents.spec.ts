// playbooks' agents screens end to end (gamma-p3-041; core/modules/playbooks/README.md "Screens"), in
// wsp_e2e_agents, this spec's alone, whose E2E_USERS are Owners (core/apps/api/tests/e2e-server.ts).
// Each test first has the e2e api's test-only module remove the workspace's agents, its sources and
// its audiences but the default, then write the signed-in user's account, another member's and the
// sources the test reads; the audiences are icp's, the agents playbooks', made through their routes;
// signals' own source checker answers, which the e2e api loads with signals (gamma-p5-045). "Agents" in
// the ICP group, New agent on a free audience, and the limit at three live agents; the agent's page,
// its name and audience, Pause and Resume, its sources: only the usable ones offered, one another
// agent holds named and off, ten at most; Archive after its confirmation, with no picker after; the
// page without a checker; a panel that throws in the campaign slot, the host's fixture panel
// (gamma-p3-065); both screens at a phone's width; another member's agent read-only for a Member,
// made by the e2e module, her own not (gamma-p6-015); her agent once she is removed, through
// tenancy's route, and the e2e module ran playbooks' removal subscriber in the worker's stead: paused
// because its owner left, with no Resume for an Owner, until she, a member again, resumes it
// (gamma-p6-075). Every text from its key; axe on each view.
import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { APIResponse, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import playbooks from "../../../modules/playbooks/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { E2E_EMAIL, expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_agents";
const SCREEN = `/w/${WORKSPACE}/agents`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
// The settings' defaults, which the e2e api runs with: the screens show the limits it answers.
const MAX_LIVE = 3; // PLAYBOOKS_MAX_AGENTS_PER_WORKSPACE
const MAX_SOURCES = 10; // PLAYBOOKS_MAX_SOURCES_PER_AGENT
const PHONE = { width: 390, height: 844 };
/** A source read through another member's account: no agent of the user's may read it. */
const OTHERS = "Another member's source";
/** A Member of the workspace, made through the e2e module's members route. */
const MEMBER = { email: "e2e-agents-member@example.com", displayName: null, role: "Member" };

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Source = { label: string; own: boolean };

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
  messages: nest({ ...playbooks, ...ui, ...web }),
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
  const ok = async (answer: APIResponse, status: number) => {
    expect(answer.status(), await answer.text()).toBe(status);
    return answer.json();
  };
  return {
    /** No agent, no source, the default audience alone; then these sources, their ids in order. */
    seed: async (sources: readonly Source[]): Promise<string[]> => {
      const answer = await page.request.post(`${API}/e2e/agents`, { data: { sources }, headers });
      return ((await ok(answer, 200)) as { sourceIds: string[] }).sourceIds;
    },
    /** The default audience's id, which icp makes on its first read. */
    defaultAudience: async (): Promise<string> => {
      const answer = await page.request.get(`${API}/icp/audiences`, { headers });
      const { audiences } = (await ok(answer, 200)) as {
        audiences: { id: string; isDefault: boolean }[];
      };
      const found = audiences.find(({ isDefault }) => isDefault);
      if (found === undefined) throw new Error("no default audience");
      return found.id;
    },
    /** A new audience, through icp's route: its id. */
    audience: async (name: string): Promise<string> => {
      const answer = await page.request.post(`${API}/icp/audiences`, { data: { name }, headers });
      return ((await ok(answer, 201)) as { id: string }).id;
    },
    /** A new agent, through playbooks' route, which takes an Idempotency-Key: its id. */
    agent: async (name: string, icpId: string): Promise<string> => {
      const answer = await page.request.post(`${API}/playbooks`, {
        data: { name, icpId },
        headers: { ...headers, "idempotency-key": randomUUID() },
      });
      return ((await ok(answer, 201)) as { id: string }).id;
    },
    /** The agent's sources, put through playbooks' route. */
    link: async (playbookId: string, sourceIds: readonly string[]): Promise<void> => {
      const path = `${API}/playbooks/${playbookId}/sources`;
      await ok(await page.request.put(path, { data: { sourceIds }, headers }), 200);
    },
    /** The Member, made a member of the workspace through the e2e module, again if removed: her membership. */
    member: async (): Promise<string> => {
      const data = { members: [MEMBER] };
      const answer = await page.request.post(`${API}/e2e/members`, { data, headers });
      const [membershipId] = ((await ok(answer, 200)) as { membershipIds: string[] }).membershipIds;
      if (membershipId === undefined) throw new Error("no membership");
      return membershipId;
    },
    /** The membership removed through tenancy's route, as an Owner removes a member. */
    remove: async (membershipId: string): Promise<void> => {
      const path = `${API}/tenancy/members/${membershipId}`;
      const answer = await page.request.delete(path, { headers });
      expect(answer.status(), await answer.text()).toBe(204);
    },
    /** The removal's event delivered to playbooks, in the worker's stead: the agent's owner's agents paused. */
    ownerRemoved: async (playbookId: string): Promise<void> => {
      const path = `${API}/e2e/agents/${playbookId}/owner-removed`;
      await ok(await page.request.post(path, { headers }), 200);
    },
  };
}

/** The agent's sources card, and a source's box in it by its label. */
function sourcesOf(page: Page) {
  const card = page.getByRole("region", { name: t("playbooks.sources.title") });
  const box = (label: string) => card.getByRole("checkbox", { name: label, exact: true });
  return { card, box };
}

const rowOf = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

test("the list shows the agents, New agent makes one on a free audience and opens its page, and three live agents are the limit", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // three page loads, a create and three axe runs
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([]);
  const founders = await api.audience("Founders");
  const agencies = await api.audience("Agencies");
  await page.goto(SCREEN);
  await expect(
    page.getByRole("heading", { level: 1, name: t("playbooks.list.title") }),
  ).toBeVisible();
  const group = page.getByRole("navigation").getByRole("list", { name: t("web.nav.icp") });
  const link = group.getByRole("link", { name: t("playbooks.nav.agents") });
  await expect(link).toHaveAttribute("href", SCREEN);
  await expect(page.getByText(t("playbooks.list.empty"))).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: t("playbooks.list.new") }).click();
  const dialog = page.getByRole("dialog", { name: t("playbooks.list.new") });
  await dialog.getByRole("textbox", { name: t("playbooks.agent.name") }).fill("Founders agent");
  const audience = dialog.getByRole("combobox", { name: t("playbooks.agent.audience") });
  // The default first, then by name: no agent holds any of them yet.
  const all = [t("playbooks.agent.default_audience"), "Agencies", "Founders"];
  await expect(audience.getByRole("option")).toHaveText(all);
  await audience.selectOption(founders);
  const icp = dialog.getByRole("link", { name: t("playbooks.list.icp_link") });
  await expect(icp).toHaveAttribute("href", `/w/${WORKSPACE}/icp`);
  // Enabled by the audience, the button fades in (the kit's transition): axe reads it once opaque.
  const createAgent = dialog.getByRole("button", { name: t("playbooks.list.create") });
  await expect(createAgent).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  await createAgent.click();
  await page.waitForURL(/\/agents\/pbk_[0-9A-Z]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Founders agent" })).toBeVisible();

  await page.getByRole("link", { name: t("playbooks.agent.back") }).click();
  const row = rowOf(page, "Founders agent");
  await expect(row.getByRole("link", { name: "Founders agent" })).toHaveAttribute(
    "href",
    new RegExp(`^${SCREEN}/pbk_`),
  );
  for (const text of [
    "Founders",
    E2E_EMAIL,
    t("playbooks.agent.status.active"),
    t("playbooks.list.source_count", { count: 0, max: MAX_SOURCES }),
  ]) {
    await expect(row).toContainText(text);
  }

  await api.agent("Default agent", await api.defaultAudience());
  await api.agent("Agencies agent", agencies);
  await page.reload();
  await expect(rowOf(page, "Agencies agent")).toContainText("Agencies");
  const create = page.getByRole("button", { name: t("playbooks.list.new") });
  await expect(create).toBeDisabled();
  const limit = t("playbooks.list.limit", { max: MAX_LIVE });
  await expect(page.getByText(limit)).toBeVisible();
  await expect(create).toHaveAccessibleDescription(limit);
  await expectAccessible(page);
});

test("the agent's page renames it, moves it to a free audience, pauses and resumes it, and links only usable sources, one another agent holds named, ten at most", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow(); // two page loads, four changes, a save and an axe run
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const own = Array.from({ length: MAX_SOURCES + 2 }, (_, index) => ({
    label: `Own source ${String(index + 1).padStart(2, "0")}`,
    own: true,
  }));
  const ids = await api.seed([...own, { label: OTHERS, own: false }]);
  const founders = await api.audience("Founders");
  const agencies = await api.audience("Agencies");
  const holder = await api.agent("Holder", await api.defaultAudience());
  const held = own[MAX_SOURCES + 1]?.label ?? "";
  await api.link(holder, [ids[MAX_SOURCES + 1] ?? ""]);
  const picker = await api.agent("Picker", founders);
  await page.goto(`${SCREEN}/${picker}`);
  await expect(page.getByRole("heading", { level: 1, name: "Picker" })).toBeVisible();
  const main = page.getByRole("main");
  const status = (key: string) =>
    main.getByText(t(`playbooks.agent.status.${key}`), { exact: true });
  await expect(status("active")).toBeVisible();

  await main.getByRole("textbox", { name: t("playbooks.agent.name") }).fill("Picker two");
  const audience = main.getByRole("combobox", { name: t("playbooks.agent.audience") });
  // Its own and the free one: the default is Holder's.
  await expect(audience.getByRole("option")).toHaveText(["Agencies", "Founders"]);
  await audience.selectOption(agencies);
  await main.getByRole("button", { name: t("ui.action.save"), exact: true }).click();
  await expect(main.getByText(t("playbooks.agent.saved"))).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Picker two" })).toBeVisible();
  await main.getByRole("button", { name: t("playbooks.agent.pause"), exact: true }).click();
  await expect(status("paused")).toBeVisible();
  await main.getByRole("button", { name: t("playbooks.agent.resume") }).click();
  await expect(status("active")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Picker two" })).toBeVisible();
  await expect(audience).toHaveValue(agencies);

  const { card, box } = sourcesOf(page);
  await expect(box(own[0]?.label ?? "")).toBeEnabled();
  // The usable ones and the held one; the other member's is left out.
  await expect(card.getByRole("checkbox")).toHaveCount(own.length);
  await expect(card.getByText(OTHERS)).toHaveCount(0);
  await expect(box(held)).toBeDisabled();
  await expect(box(held)).toHaveAccessibleDescription(
    t("playbooks.sources.held_by", { agent: "Holder" }),
  );
  const chosen = (count: number) => t("playbooks.sources.chosen", { count, max: MAX_SOURCES });
  await expect(card.getByText(chosen(0))).toBeVisible();
  for (const { label } of own.slice(0, MAX_SOURCES)) await box(label).check();
  await expect(card.getByText(chosen(MAX_SOURCES))).toBeVisible();
  await expect(card.getByText(t("playbooks.sources.full"))).toBeVisible();
  await expect(box(own[MAX_SOURCES]?.label ?? "")).toBeDisabled();
  await expectAccessible(page);
  const put = page.waitForResponse(
    (answer) => answer.request().method() === "PUT" && answer.url().endsWith("/sources"),
  );
  await card.getByRole("button", { name: t("playbooks.sources.save") }).click();
  expect((await put).status()).toBe(200);
  await expect(card.getByText(t("playbooks.sources.saved"))).toBeVisible();

  await page.reload();
  for (const { label } of own.slice(0, MAX_SOURCES)) await expect(box(label)).toBeChecked();
  await expect(box(own[MAX_SOURCES]?.label ?? "")).not.toBeChecked();
  await page.goto(SCREEN);
  await expect(rowOf(page, "Picker two")).toContainText(
    t("playbooks.list.source_count", { count: MAX_SOURCES, max: MAX_SOURCES }),
  );
});

test("a Web research source, which reads through no LinkedIn account, is offered on the agent's page, linked and kept (gamma-wr-030)", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  const api = apiOf(page, origin);
  await api.seed([]);
  const body = {
    kind: "web_research",
    config: { focus: "makers of paper cups" },
    label: "Web cups",
  };
  const made = await page.request.post(`${API}/signals/sources`, {
    data: body,
    headers: { origin },
  });
  expect(made.status(), await made.text()).toBe(201);
  const { id, senderAccountId } = (await made.json()) as { id: string; senderAccountId: null };
  expect(senderAccountId).toBeNull();
  const agent = await api.agent("Web picker", await api.defaultAudience());
  await page.goto(`${SCREEN}/${agent}`);
  const { card, box } = sourcesOf(page);
  await expect(box("Web cups")).toBeEnabled();
  await box("Web cups").check();
  const put = page.waitForResponse(
    (answer) => answer.request().method() === "PUT" && answer.url().endsWith("/sources"),
  );
  await card.getByRole("button", { name: t("playbooks.sources.save") }).click();
  expect((await put).status()).toBe(200);
  await expect(card.getByText(t("playbooks.sources.saved"))).toBeVisible();
  await page.reload();
  await expect(box("Web cups")).toBeChecked();
  const read = await page.request.get(`${API}/signals/sources`);
  const { sources } = (await read.json()) as { sources: { id: string; playbook: unknown }[] };
  expect(sources.find((source) => source.id === id)?.playbook).not.toBeNull();
  await expectAccessible(page);
});

test("Archive asks first, then the agent no longer changes and its page offers no source", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([{ label: "Own source", own: true }]);
  const agent = await api.agent("To archive", await api.defaultAudience());
  await page.goto(`${SCREEN}/${agent}`);
  const { card, box } = sourcesOf(page);
  await expect(box("Own source")).toBeEnabled();
  const main = page.getByRole("main");
  await main.getByRole("button", { name: t("playbooks.agent.archive") }).click();
  const confirm = page.getByRole("dialog", { name: t("playbooks.agent.archive_title") });
  await expect(confirm.getByText(t("playbooks.agent.archive_body"))).toBeVisible();
  await expectAccessible(page);
  await confirm.getByRole("button", { name: t("playbooks.agent.archive") }).click();
  await expect(main.getByText(t("playbooks.agent.archived"))).toBeVisible();

  await page.reload();
  await expect(main.getByText(t("playbooks.agent.archived"))).toBeVisible();
  const archived = t("playbooks.agent.status.archived");
  await expect(main.getByText(archived, { exact: true })).toBeVisible();
  for (const key of ["pause", "resume", "archive"]) {
    await expect(main.getByRole("button", { name: t(`playbooks.agent.${key}`) })).toHaveCount(0);
  }
  await expect(main.getByRole("textbox")).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await expect(main.getByRole("checkbox")).toHaveCount(0);
  await expectAccessible(page);
  await page.goto(SCREEN);
  await expect(rowOf(page, "To archive")).toContainText(archived);
});

test("without a source checker the agent's page says sources cannot be linked yet", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([{ label: "Own source", own: true }]);
  const agent = await api.agent("No checker", await api.defaultAudience());
  // The e2e api has a checker: the api's answer without one (playbooks' README) stands in for it.
  await page.route(
    (url) => url.pathname.endsWith("/sources/check"),
    (route) => route.fulfill({ status: 503, json: { code: "playbook_source_checker_missing" } }),
  );
  await page.goto(`${SCREEN}/${agent}`);
  const { card } = sourcesOf(page);
  await expect(card.getByText(t("playbooks.errors.playbook_source_checker_missing"))).toBeVisible();
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expectAccessible(page);
});

test("the list and the agent's page fit a phone's width, with a long name and a long label", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  const label = "Engagers of the founder's post about hiring a first sales rep in a seed company";
  await api.seed([{ label, own: true }]);
  const name = "Founders of seed-stage software companies who are hiring their first sales rep";
  const agent = await api.agent(name, await api.defaultAudience());
  await page.setViewportSize(PHONE);
  await page.goto(SCREEN);
  await expect(rowOf(page, name)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page), "the list").toEqual([]);
  await page.goto(`${SCREEN}/${agent}`);
  await expect(sourcesOf(page).box(label)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(await overflows(page), "the agent's page").toEqual([]);
});

test("a panel that throws in the campaign slot says so in its place, with Try again, and the agent stays up", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([]);
  const agent = await api.agent("Its panel throws", await api.defaultAudience());
  // The host's fixture panel in the slot throws, as the cookie asks (its ui/failing/panel.tsx).
  await context.addCookies([{ name: "fixture_panel", value: "throw", url: baseURL ?? "" }]);
  await page.goto(`${SCREEN}/${agent}`);
  await expect(page.getByRole("heading", { level: 1, name: "Its panel throws" })).toBeVisible();
  await expect(page.getByText(t("playbooks.agent.slot_failed"), { exact: true })).toBeVisible();
  const failed = page.getByRole("alert").filter({ hasText: t("ui.state.error") });
  await expect(failed.getByRole("button", { name: t("ui.action.retry") })).toBeVisible();
  // The agent's own controls and its sources card are still there.
  await expect(
    page.getByRole("button", { name: t("playbooks.agent.pause"), exact: true }),
  ).toBeVisible();
  await expect(sourcesOf(page).card).toBeVisible();
  await expectAccessible(page);
});

test("a Member sees another member's agent read-only, with the hint: its name and audience off, no Pause, Archive or Save, its sources' boxes off; her own she changes", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([{ label: "Own source", own: true }]);
  const theirs = await api.agent("The Owner's agent", await api.defaultAudience());
  await api.member();
  await signInAs(MEMBER.email);
  await page.goto(`${SCREEN}/${theirs}`);
  await expect(page.getByRole("heading", { level: 1, name: "The Owner's agent" })).toBeVisible();
  const main = page.getByRole("main");
  const hint = main.getByText(t("playbooks.agent.not_owner"));
  const name = main.getByRole("textbox", { name: t("playbooks.agent.name") });
  await expect(hint).toBeVisible();
  await expect(name).toBeDisabled();
  await expect(main.getByRole("combobox", { name: t("playbooks.agent.audience") })).toBeDisabled();
  for (const key of ["playbooks.agent.pause", "playbooks.agent.archive", "ui.action.save"]) {
    await expect(main.getByRole("button", { name: t(key), exact: true })).toHaveCount(0);
  }
  const { card, box } = sourcesOf(page);
  await expect(box("Own source")).toBeDisabled();
  await expect(card.getByRole("button", { name: t("playbooks.sources.save") })).toHaveCount(0);
  await expectAccessible(page);

  const hers = await api.agent("Her agent", await api.audience("Her audience"));
  await page.goto(`${SCREEN}/${hers}`);
  await expect(page.getByRole("heading", { level: 1, name: "Her agent" })).toBeVisible();
  await expect(hint).toHaveCount(0);
  await name.fill("Her agent, renamed");
  await main.getByRole("button", { name: t("ui.action.save"), exact: true }).click();
  await expect(main.getByText(t("playbooks.agent.saved"))).toBeVisible();
  await main.getByRole("button", { name: t("playbooks.agent.pause"), exact: true }).click();
  await expect(main.getByText(t("playbooks.agent.status.paused"), { exact: true })).toBeVisible();
});

test("an agent whose owner left says so in the list and on its page, with no Resume for an Owner; its owner, a member again, resumes it", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const api = apiOf(page, baseURL ?? "");
  await api.seed([]);
  const membershipId = await api.member();
  const icpId = await api.audience("Her audience");
  await signInAs(MEMBER.email);
  const hers = await api.agent("Her agent", icpId);
  await signInAs();
  await api.remove(membershipId);
  await api.ownerRemoved(hers);

  const ownerLeft = t("playbooks.agent.status.paused_owner_removed");
  await page.goto(SCREEN);
  const row = rowOf(page, "Her agent");
  await expect(row.getByText(ownerLeft, { exact: true })).toBeVisible();
  await expect(row.getByText(t("playbooks.list.former_member"), { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.goto(`${SCREEN}/${hers}`);
  const main = page.getByRole("main");
  const why = main.getByText(t("playbooks.errors.playbook_owner_removed"));
  const resume = main.getByRole("button", { name: t("playbooks.agent.resume"), exact: true });
  await expect(page.getByRole("heading", { level: 1, name: "Her agent" })).toBeVisible();
  await expect(main.getByText(ownerLeft, { exact: true })).toBeVisible();
  await expect(why).toBeVisible();
  await expect(resume).toHaveCount(0);
  await expect(main.getByRole("button", { name: t("playbooks.agent.archive") })).toBeVisible();
  await expectAccessible(page);

  await api.member();
  await signInAs(MEMBER.email);
  await page.goto(`${SCREEN}/${hers}`);
  await expect(page.getByRole("heading", { level: 1, name: "Her agent" })).toBeVisible();
  await expect(why).toHaveCount(0);
  await resume.click();
  await expect(main.getByText(t("playbooks.agent.status.active"), { exact: true })).toBeVisible();
});
