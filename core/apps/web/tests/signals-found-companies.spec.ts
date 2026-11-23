// signals' Companies found screen, the source card's link and the agent's panel end to end
// (gamma-wr-111; core/modules/signals/README.md "Screen"), in wsp_e2e_found, this spec's alone, whose
// E2E_USERS are Owners (core/apps/api/tests/e2e-server.ts). Each test first has the e2e api remove the
// workspace's agents, sources and audiences but the default (POST …/e2e/agents), makes Web research
// sources through signals' route and an agent through playbooks', and has the e2e api's test-only route
// write the found companies (POST /test/signals/found), as no public route writes them. The list opens
// on fit and unsure, newest first, each card its reasons with their quote and a link to their page
// (rel noopener noreferrer), the page that led to it and its source type, how to reach it; the Not a
// fit filter shows the others and says a member set it; the source and agent filters narrow it; the
// source's card links to it with the source chosen; Not a fit asks first and moves the card; a member
// who did not add the source has no button, nor Download CSV, an Owner downloads the view with a
// byte-order mark; the empty and failed states; the agent's page shows the panel with the agent's five
// newest fitting companies and the link to the screen with the agent chosen; both at a phone's width.
// Every text from its key; axe on each view.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import playbooks from "../../../modules/playbooks/messages/en.json" with { type: "json" };
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import web from "../messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_found";
const SCREEN = `/w/${WORKSPACE}/companies-found`;
const API = `/api/v1/workspaces/${WORKSPACE}`;
const SEED = `http://127.0.0.1:${process.env.API_PORT}/test/signals/found`;
const PHONE = { width: 390, height: 844 };
/** A Member of the workspace, made through the e2e module's members route. */
const MEMBER = { email: "e2e-found-member@example.com", displayName: null, role: "Member" };
const DAY = 86_400_000;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Company = {
  domain: string;
  name: string;
  verdict: "fit" | "not_fit" | "unsure";
  daysAgo: number;
  [key: string]: unknown;
};

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
  messages: nest({ ...playbooks, ...signals, ...ui, ...web }),
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

/** One reason as the judge keeps it: what it shows, its line, its quote and its page. */
const reason = (url: string, quote: string) => ({
  ...{ kind: "focus", criterion: "Makes paper cups", answer: "shown" },
  ...{ line: "Makes paper cups for cafés.", quote, url, readAt: new Date(DAY).toISOString() },
});

/** The routes the tests stand on, as the signed-in user, through the web's /api rewrite. */
function apiOf(page: Page, origin: string, seeds: APIRequestContext) {
  const headers = { origin };
  const ok = async (answer: APIResponse, status = 200) => {
    expect(answer.status(), await answer.text()).toBe(status);
    return answer.json();
  };
  return {
    /** No agent, source or audience but the default: the workspace as a test starts. */
    clear: async (): Promise<void> => {
      const data = { sources: [] };
      await ok(await page.request.post(`${API}/e2e/agents`, { data, headers }));
    },
    /** A Web research source, through signals' route: its id. */
    source: async (label: string): Promise<string> => {
      const config = { focus: "makers of paper cups" };
      const data = { kind: "web_research", config, label };
      const made = await ok(
        await page.request.post(`${API}/signals/sources`, { data, headers }),
        201,
      );
      return (made as { id: string }).id;
    },
    /** The source's found companies, the workspace's own removed first when `reset`. */
    found: async (sourceId: string, companies: Company[], reset = false): Promise<void> => {
      const now = Date.now();
      const rows = companies.map(({ daysAgo, ...row }) => ({
        ...row,
        judgedAt: new Date(now - daysAgo * DAY).toISOString(),
      }));
      const answer = await seeds.post(SEED, { data: { sourceId, companies: rows, reset } });
      expect(answer.status(), await answer.text()).toBe(200);
    },
    /** A new audience of its own through icp's route, which one live agent holds at most: its id. */
    audience: async (name: string): Promise<string> => {
      const answer = await page.request.post(`${API}/icp/audiences`, { data: { name }, headers });
      return ((await ok(answer, 201)) as { id: string }).id;
    },
    /** An agent through playbooks' route, on the default audience unless one is given, holding these sources: its id. */
    agent: async (name: string, sourceIds: string[], audience?: string): Promise<string> => {
      const read = await ok(await page.request.get(`${API}/icp/audiences`, { headers }));
      const { audiences } = read as { audiences: { id: string; isDefault: boolean }[] };
      const icpId = audience ?? audiences.find(({ isDefault }) => isDefault)?.id ?? "";
      const made = await page.request.post(`${API}/playbooks`, {
        data: { name, icpId },
        headers: { ...headers, "idempotency-key": randomUUID() },
      });
      const { id } = (await ok(made, 201)) as { id: string };
      const path = `${API}/playbooks/${id}/sources`;
      await ok(await page.request.put(path, { data: { sourceIds }, headers }));
      return id;
    },
    /** The Member, made a member of the workspace through the e2e module. */
    member: async (): Promise<void> => {
      const data = { members: [MEMBER] };
      await ok(await page.request.post(`${API}/e2e/members`, { data, headers }));
    },
  };
}

/** The cards' names, in the order shown. */
const names = (page: Page) => page.getByRole("heading", { level: 3 }).allTextContents();

test("the list opens on fit and unsure, newest first: each card its reasons with their quote and a link to their page, the page that led to it with its source type, how to reach it; Not a fit shows the others, a member's own marked; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  test.slow(); // seeds, three views and axe
  await signInAs();
  const api = apiOf(page, baseURL ?? "", request);
  await api.clear();
  const source = await api.source("Cups north");
  const own = {
    ...{ country: "BR", town: "São Paulo", state: "SP", placeId: "fair_exhibitors" },
    ...{ pageUrl: "https://fair.example/list", email: "contato@aurora.example" },
    ...{ phones: ["+55 11 4002 8922"], postalAddress: "Rua das Flores 120" },
    reasons: [reason("https://aurora.example/about", "Fabricamos copos de papel")],
  };
  await api.found(
    source,
    [
      { domain: "older.example", name: "Older Cups", verdict: "unsure", daysAgo: 5 },
      { domain: "aurora.example", name: "Aurora Copos", verdict: "fit", daysAgo: 1, ...own },
      { domain: "klein.example", name: "Klein Becher", verdict: "not_fit", daysAgo: 2 },
    ],
    true,
  );
  await page.goto(SCREEN);
  await expect(
    page.getByRole("heading", { level: 1, name: t("signals.found.title") }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(2);
  expect(await names(page)).toEqual(["Aurora Copos", "Older Cups"]);
  const card = page.getByRole("region", { name: "Aurora Copos" });
  await expect(card.getByText(t("signals.found.verdict.fit"), { exact: true })).toBeVisible();
  await expect(card.getByText("São Paulo, SP, BR")).toBeVisible();
  await expect(card.getByText(t("signals.found.reason.focus"))).toBeVisible();
  await expect(card.getByText("Makes paper cups for cafés.")).toBeVisible();
  await expect(card.getByText("Fabricamos copos de papel")).toBeVisible();
  const reasonLink = card.getByRole("link", { name: "aurora.example" }).nth(1);
  await expect(reasonLink).toHaveAttribute("href", "https://aurora.example/about");
  await expect(reasonLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(reasonLink).toHaveAttribute("target", "_blank");
  await expect(card.getByRole("link", { name: "fair.example" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(card.getByText(t("signals.places.fair_exhibitors.label"))).toBeVisible();
  await expect(card.getByText("contato@aurora.example")).toBeVisible();
  await expect(card.getByText("+55 11 4002 8922")).toBeVisible();
  await expect(card.getByText("Rua das Flores 120")).toBeVisible();
  await expect(card.getByText(t("signals.found.leads_none"))).toBeVisible();
  await expect(card.getByText("Cups north")).toBeVisible();
  await expectAccessible(page);

  await page
    .getByRole("combobox", { name: t("signals.found.filter.verdict"), exact: true })
    .selectOption({ label: t("signals.found.filter.verdict_not_fit") });
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);
  expect(await names(page)).toEqual(["Klein Becher"]);
  await expect(page).toHaveURL(`${SCREEN}?verdict=not_fit`);
  await expectAccessible(page);
});

test("the source and agent filters narrow the list; the source's card links to the screen with its source chosen, and an address opens it so; no company, the empty state", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  test.slow();
  await signInAs();
  const api = apiOf(page, baseURL ?? "", request);
  await api.clear();
  const north = await api.source("Cups north");
  const south = await api.source("Cups south");
  await api.found(
    north,
    [{ domain: "n.example", name: "North Cups", verdict: "fit", daysAgo: 1 }],
    true,
  );
  await api.found(south, [{ domain: "s.example", name: "South Cups", verdict: "fit", daysAgo: 2 }]);
  const agent = await api.agent("Cups agent", [north]);

  await page.goto(SCREEN);
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(2);
  await page
    .getByRole("combobox", { name: t("signals.found.filter.source"), exact: true })
    .selectOption({ label: "Cups south" });
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);
  expect(await names(page)).toEqual(["South Cups"]);
  await page
    .getByRole("combobox", { name: t("signals.found.filter.source"), exact: true })
    .selectOption({ label: t("signals.found.filter.any_source") });
  await page
    .getByRole("combobox", { name: t("signals.found.filter.agent"), exact: true })
    .selectOption({ label: "Cups agent" });
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(1);
  expect(await names(page)).toEqual(["North Cups"]);

  await page.goto(`${SCREEN}?source=${south}`);
  await expect(
    page.getByRole("combobox", { name: t("signals.found.filter.source"), exact: true }),
  ).toHaveValue(south);
  expect(await names(page)).toEqual(["South Cups"]);

  // The source's card on Sources: its link, then the screen on that source.
  await page.goto(`/w/${WORKSPACE}/sources`);
  const link = page.getByRole("link", {
    name: t("signals.sources.companies_found_of", { label: "Cups north" }),
  });
  await expect(link).toHaveAttribute("href", `${SCREEN}?source=${north}`);
  await link.click();
  await expect(
    page.getByRole("combobox", { name: t("signals.found.filter.source"), exact: true }),
  ).toHaveValue(north);
  expect(await names(page)).toEqual(["North Cups"]);
  void agent;

  // A view with no company: the empty state.
  await page.goto(`${SCREEN}?verdict=unsure`);
  await expect(page.getByText(t("signals.found.empty"))).toBeVisible();
  await expectAccessible(page);
});

test("Not a fit asks first: Cancel changes nothing, the confirmation moves the card out of the view and the Not a fit view shows it as a member's; a member who did not add the source has no button and no Download CSV, an owner downloads the view with a byte-order mark; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  test.slow(); // seeds, a mark, a download, a second sign-in and axe
  await signInAs();
  const api = apiOf(page, baseURL ?? "", request);
  await api.clear();
  const source = await api.source("Cups north");
  await api.found(
    source,
    [
      { domain: "a.example", name: "=Formula Cups", verdict: "fit", daysAgo: 1 },
      { domain: "b.example", name: "Plain Cups", verdict: "fit", daysAgo: 2 },
    ],
    true,
  );
  await page.goto(SCREEN);
  const formula = page.getByRole("region", { name: "=Formula Cups" });
  await formula
    .getByRole("button", { name: t("signals.found.not_fit_of", { name: "=Formula Cups" }) })
    .click();
  const dialog = page.getByRole("dialog", {
    name: t("signals.found.not_fit_title", { name: "=Formula Cups" }),
  });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: t("ui.action.cancel") }).click();
  await expect(dialog).toBeHidden();
  expect(await names(page)).toEqual(["=Formula Cups", "Plain Cups"]);

  // The owner's file: the view as it stands, the byte-order mark first, a formula cell neutralized.
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: t("signals.found.download") }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^companies-found-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile(await download.path(), "utf8");
  expect(text.startsWith("﻿company,website,verdict,")).toBe(true);
  expect(text).toContain("'=Formula Cups");

  await formula
    .getByRole("button", { name: t("signals.found.not_fit_of", { name: "=Formula Cups" }) })
    .click();
  await dialog.getByRole("button", { name: t("signals.found.not_fit_confirm") }).click();
  await expect(page.getByText(t("signals.found.marked", { name: "=Formula Cups" }))).toBeVisible();
  expect(await names(page)).toEqual(["Plain Cups"]);
  await page
    .getByRole("combobox", { name: t("signals.found.filter.verdict"), exact: true })
    .selectOption({ label: t("signals.found.filter.verdict_not_fit") });
  const marked = page.getByRole("region", { name: "=Formula Cups" });
  await expect(marked).toBeVisible();
  await expect(
    marked.getByText(
      t("signals.found.verdict.by_member", { verdict: t("signals.found.verdict.not_fit") }),
    ),
  ).toBeVisible();
  await expect(marked.getByRole("button")).toHaveCount(0);

  // A member who did not add the source: the card, no Not a fit, no Download CSV; her own source's, Not a fit.
  await api.member();
  await signInAs(MEMBER.email);
  await page.goto(SCREEN);
  await expect(page.getByRole("region", { name: "Plain Cups" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("signals.found.not_fit_of", { name: "Plain Cups" }) }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: t("signals.found.download") })).toHaveCount(0);
  const hers = await api.source("Her cups");
  await api.found(hers, [{ domain: "h.example", name: "Her Cups", verdict: "fit", daysAgo: 0 }]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: t("signals.found.not_fit_of", { name: "Her Cups" }) }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: t("signals.found.not_fit_of", { name: "Plain Cups" }) }),
  ).toHaveCount(0);
  await expectAccessible(page);
});

test("a list the api fails shows the code in words and a retry that reads it again; the screen and the agent's page at a phone's width", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  test.slow();
  await signInAs();
  const api = apiOf(page, baseURL ?? "", request);
  await api.clear();
  const source = await api.source("Cups north");
  await api.found(
    source,
    [{ domain: "n.example", name: "North Cups", verdict: "fit", daysAgo: 1 }],
    true,
  );
  const list = "**/api/v1/workspaces/*/signals/found-companies?*";
  await page.route(list, (route) =>
    route.fulfill({ status: 500, json: { code: "internal_error" } }),
  );
  await page.goto(SCREEN);
  await expect(page.getByRole("alert")).toBeVisible();
  await expectAccessible(page);
  await page.unroute(list);
  await page.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(page.getByRole("region", { name: "North Cups" })).toBeVisible();

  const agent = await api.agent("Cups agent", [source]);
  await page.setViewportSize(PHONE);
  for (const path of [SCREEN, `/w/${WORKSPACE}/agents/${agent}`]) {
    await page.goto(path);
    await expect(page.getByText("North Cups")).toBeVisible();
    expect(await overflows(page), path).toEqual([]);
  }
});

test("the agent's page shows the panel with the agent's five newest fitting companies only, the link to the screen with the agent chosen; no fitting company, the empty state; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  test.slow();
  await signInAs();
  const api = apiOf(page, baseURL ?? "", request);
  await api.clear();
  const mine = await api.source("Cups north");
  const other = await api.source("Cups south");
  const fits: Company[] = Array.from({ length: 6 }, (_, n) => ({
    ...{
      domain: `fit-${n}.example`,
      name: `Fit Cups ${n}`,
      verdict: "fit" as const,
      daysAgo: n + 1,
    },
    ...{ town: "Lisboa", country: "PT" },
  }));
  await api.found(
    mine,
    [...fits, { domain: "u.example", name: "Unsure Cups", verdict: "unsure", daysAgo: 0 }],
    true,
  );
  await api.found(other, [{ domain: "o.example", name: "Other Cups", verdict: "fit", daysAgo: 0 }]);
  const agent = await api.agent("Cups agent", [mine]);
  const empty = await api.agent("Empty agent", [], await api.audience("Empty audience"));

  await page.goto(`/w/${WORKSPACE}/agents/${agent}`);
  await expect(page.getByRole("heading", { level: 1, name: "Cups agent" })).toBeVisible();
  const panel = page.getByRole("region", { name: t("signals.agent_companies.title") });
  await expect(panel.getByRole("listitem")).toHaveCount(5);
  await expect(panel.getByText("Fit Cups 0")).toBeVisible();
  await expect(panel.getByText("Fit Cups 4")).toBeVisible();
  await expect(panel.getByText("Fit Cups 5")).toHaveCount(0);
  await expect(panel.getByText("Unsure Cups")).toHaveCount(0);
  await expect(panel.getByText("Other Cups")).toHaveCount(0);
  await expect(panel.getByText("fit-0.example · Lisboa · PT")).toBeVisible();
  const all = panel.getByRole("link", { name: t("signals.agent_companies.view_all") });
  await expect(all).toHaveAttribute("href", `${SCREEN}?agent=${agent}`);
  await expectAccessible(page);
  await all.click();
  await expect(
    page.getByRole("combobox", { name: t("signals.found.filter.agent"), exact: true }),
  ).toHaveValue(agent);
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(7);

  await page.goto(`/w/${WORKSPACE}/agents/${empty}`);
  const none = page.getByRole("region", { name: t("signals.agent_companies.title") });
  await expect(none.getByText(t("signals.agent_companies.empty"))).toBeVisible();
  await expectAccessible(page);
});
