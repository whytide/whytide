// enrichment's company panel in the company slot of contacts' lead page (gamma-en-055;
// core/modules/enrichment/README.md "The lead page"), on leads the e2e api's test-only module writes
// (core/apps/api/tests/fixtures/e2e) in wsp_e2e_enrichment, this spec's alone, whose runs it ends
// as the run on the fake port leaves them, with facts stamped open data and a vendor's name (the
// e2e api runs no worker): the facts filled, each with its class's words and its date, and the last
// run's line; a company with nothing found yet, and a lead with no company, the empty state; the
// country a member set, "Set by a member"; "Enrich now", then "Enriching…" while the run is queued,
// then the facts without a reload, as the panel reads again; the loading state while the read
// waits, and the error state when it fails, whose Try again reads again. No vendor's name in the
// panel. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import enrichment from "../../../modules/enrichment/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_enrichment";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const E2E = `${API}/e2e`;
/**
 * The workspace's three leads, each with a company of its own, but the last: persons, companies and
 * runs outlive a seed, so each seed's are new, by a suffix of its own.
 */
function leads() {
  const suffix = Math.random().toString(36).slice(2, 10);
  const company = (name: string) => ({
    name,
    linkedinUrl: `https://www.linkedin.com/company/${name.toLowerCase()}-${suffix}`,
  });
  return [
    {
      slug: `e2e-enrich-filled-${suffix}`,
      firstName: "Fia",
      lastName: "Filled",
      company: company("Corvid"),
    },
    {
      slug: `e2e-enrich-empty-${suffix}`,
      firstName: "Emil",
      lastName: "Empty",
      company: company("Wren"),
    },
    { slug: `e2e-enrich-none-${suffix}`, firstName: "Nina", lastName: "None" },
  ].map((lead) => ({ ...lead, source: "imported" }));
}
/**
 * What a run on the fake port brings: open data's facts, the domain the person's own, since a
 * workspace's companies never share one.
 */
const domainOf = (personId: string) => `${personId.toLowerCase().replace(/_/g, "-")}.com`;
const facts = (personId: string) => ({
  ...{ domain: domainOf(personId), industry: "Logistics", sizeRange: "51-200" },
});
/** The vendor's and the source's names the e2e module records: never shown. */
const VENDOR = /wikidata|company-data/i;

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
  messages: nest({ ...contacts, ...enrichment, ...platform, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;
const p = (key: string, values?: Record<string, string | number>) =>
  t(`enrichment.company_panel.${key}`, values);
/** The browser's zone (test.use below), in which the panel writes its dates (gamma-en-100). */
const ZONE = "UTC";
/** Today, as the panel writes a date (the run and the stamps are written now), at any hour. */
const today = () =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: ZONE }).format(new Date());

/** The workspace's three leads; their ids. */
async function seed(page: Page, origin: string | undefined) {
  const headers = { origin: origin ?? "" };
  const answer = await page.request.post(`${E2E}/leads`, { data: { leads: leads() }, headers });
  expect(answer.status(), await answer.text()).toBe(200);
  const [filled = "", empty = "", none = ""] = ((await answer.json()) as { personIds: string[] })
    .personIds;
  return { filled, empty, none };
}

/** The person's run ended with its facts, as the worker would end it. */
async function endRun(page: Page, origin: string | undefined, personId: string) {
  const answer = await page.request.post(`${E2E}/enrichment/${personId}`, {
    data: { company: facts(personId) },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: p("title") });
/** A field's value and its line, as a reader reads them. */
const field = (page: Page, key: string) =>
  panelOf(page)
    .locator("dl > div")
    .filter({ has: page.getByText(p(`field.${key}`), { exact: true }) });

test.use({ timezoneId: ZONE });

test("the facts filled, each with its class's words and its date; an empty one Not found yet; the last run's line; no vendor's name; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { filled } = await seed(page, baseURL);
  await endRun(page, baseURL, filled);
  await page.goto(leadPath(filled));
  const panel = panelOf(page);
  const from = t("contacts.provenance.source.open_data");
  const line = p("provenance", { source: from, date: today() });
  await expect(field(page, "domain")).toContainText(domainOf(filled));
  await expect(field(page, "domain")).toContainText(line);
  await expect(field(page, "industry")).toContainText("Logistics");
  await expect(field(page, "industry")).toContainText(line);
  await expect(field(page, "size_range")).toContainText("51-200");
  await expect(field(page, "description")).toContainText(p("not_found"));
  await expect(panel).toContainText(p("last_enriched", { date: today(), count: 3 }));
  await expect(panel).toContainText(p("outcomes", { outcomes: t("enrichment.outcome.found") }));
  await expect(panel).not.toContainText(VENDOR);
  await expect(panel.getByRole("button", { name: p("enrich_now") })).toBeEnabled();
  await axe(page);
});

test("a company with nothing found yet; a lead with no company, the empty state; both Not enriched yet; the country a member set reads Set by a member; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { empty, none } = await seed(page, baseURL);
  // The member's own location, from which contacts keeps the country with the member's stamp.
  const edit = await page.request.patch(`${API}/contacts/leads/${empty}`, {
    data: { locationText: "Berlin, Germany" },
    headers: { origin: baseURL ?? "" },
  });
  expect(edit.status(), await edit.text()).toBe(200);
  await page.goto(leadPath(empty));
  const panel = panelOf(page);
  await expect(field(page, "domain")).toContainText(p("not_found"));
  await expect(field(page, "industry")).toContainText(p("not_found"));
  await expect(field(page, "person_country")).toContainText("Germany");
  await expect(field(page, "person_country")).toContainText(
    p("set_by_member_at", { date: today() }),
  );
  await expect(panel).toContainText(p("not_enriched"));
  await axe(page);

  await page.goto(leadPath(none));
  await expect(panel.getByText(p("no_company"), { exact: true })).toBeVisible();
  await expect(field(page, "person_country")).toContainText(p("not_found"));
  await expect(panel).toContainText(p("not_enriched"));
  await axe(page);
});

test("Enrich now: the button reads Enriching… and waits while the run is queued; once it ends, the facts show without a reload; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { empty } = await seed(page, baseURL);
  await page.goto(leadPath(empty));
  const panel = panelOf(page);
  await expect(field(page, "domain")).toContainText(p("not_found"));
  await panel.getByRole("button", { name: p("enrich_now") }).click();
  const enriching = panel.getByRole("button", { name: p("enriching") });
  await expect(enriching).toBeDisabled();
  await axe(page);

  await endRun(page, baseURL, empty);
  // The panel reads again every 3 seconds while the run works: well within its 60.
  await expect(field(page, "domain")).toContainText(domainOf(empty), { timeout: 10_000 });
  await expect(panel.getByRole("button", { name: p("enrich_now") })).toBeEnabled();
  await expect(panel).toContainText(p("last_enriched", { date: today(), count: 3 }));
  await expect(panel).not.toContainText(VENDOR);
  await axe(page);
});

test("the loading state while the read waits; a failed read, the error state, whose Try again reads again; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { filled } = await seed(page, baseURL);
  const route = `**${API}/enrichment/leads/${filled}`;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(route, async (request) => {
    await held;
    await request.fulfill({ status: 500, json: { code: "internal_error" } });
  });
  await page.goto(leadPath(filled));
  const slot = page.locator('[data-slot="company"]');
  // The slot's first panel (ui/nav.ts); the Email panel under it (gamma-en-081) loads on its own.
  await expect(slot.getByRole("status").first()).toHaveText(t("ui.state.loading"));
  await axe(page);
  release();
  const alert = panelOf(page).getByRole("alert");
  await expect(alert).toContainText(t("ui.state.error"));
  await expect(alert).toContainText(t("platform.error.generic"));
  await axe(page);

  await page.unroute(route);
  await alert.getByRole("button", { name: t("ui.action.retry") }).click();
  await expect(alert).toHaveCount(0);
  await expect(field(page, "domain")).toBeVisible();
});
