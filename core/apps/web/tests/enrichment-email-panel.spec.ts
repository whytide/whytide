// enrichment's Email panel in the company slot of contacts' lead page, under the company panel
// (gamma-en-081; core/modules/enrichment/README.md "The Email panel"), on leads the e2e api's
// test-only module writes (core/apps/api/tests/fixtures/e2e) in wsp_e2e_email_panel, this spec's
// alone, whose lookups it ends as the lookup on the fake finder and verifier leaves them, with a
// vendor's name on the address and the steps (the e2e api runs no worker): "Find email" with its
// price first, from credits' price list, then "Looking up…" while the lookup is queued, then the
// address, its kind, class and date without a reload, and "Verify again" in its place, free; "Verify
// again" ending invalid, the verdict and the last lookup's reason; a lookup ended without an
// address, why; a personal address of a lead with no known country, not used and why. No vendor's
// or source's name in the panel. Every text from its key; axe on each state. The dates in the
// browser's time zone (gamma-en-100): a lookup ended at 00:30 in Kolkata reads that day there, and
// the day before in UTC. gamma-wr-100: a lead's phones (the numbers a public page printed with them),
// each with the page as a link that opens with no opener, one whose page was not kept, and none
// with an address's words; a lead with a phone and no address still offers Find email.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createTranslator } from "next-intl";
import enrichment from "../../../modules/enrichment/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_email_panel";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const E2E = `${API}/e2e`;
/** The vendors' and the sources' names the e2e module records: never shown. */
const NAMES = /hunter|zerobounce|email-finder|email-verifier/i;

/** Persons and their addresses outlive a seed: each seed's are new, by a suffix of its own. */
function leads(suffix: string) {
  return ["Find", "Held", "Personal", "Phone"].map((lastName) => ({
    slug: `e2e-email-${lastName.toLowerCase()}-${suffix}`,
    firstName: "Noor",
    lastName,
    source: "imported",
  }));
}

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
  messages: nest({ ...enrichment, ...ui }),
  onError: (error) => {
    throw error;
  },
}) as unknown as Translate;
const e = (key: string, values?: Record<string, string | number>) =>
  t(`enrichment.email_panel.${key}`, values);
/**
 * Today, as the panel writes a date (the lookups are ended now): in the browser's zone, which the
 * shell gives next-intl (gamma-en-100); with no timezoneId, this machine's.
 */
const today = () => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date());
/** A day as the panel writes it in a zone. */
const dayIn = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone }).format(new Date(instant));
/** 00:30 on 15 November 2026 in Kolkata, still the 14th in UTC. */
const PAST_MIDNIGHT_IN_KOLKATA = "2026-11-14T19:00:00.000Z";

/** The workspace's three leads; their ids, and the suffix of their addresses. */
async function seed(page: Page, origin: string | undefined) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const headers = { origin: origin ?? "" };
  const answer = await page.request.post(`${E2E}/leads`, {
    data: { leads: leads(suffix) },
    headers,
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const ids = ((await answer.json()) as { personIds: string[] }).personIds;
  const [find = "", held = "", personal = "", phone = ""] = ids;
  return { find, held, personal, phone, suffix };
}

/** The person's latest lookup ended, as the worker would end it. */
async function endLookup(
  page: Page,
  origin: string | undefined,
  personId: string,
  body: { address?: string; kind?: string; verdict?: string; reason?: string; at?: string },
) {
  const answer = await page.request.post(`${E2E}/work-email/${personId}`, {
    data: body,
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

/** A phone written on the person, as the people's step keeps one. */
async function keepPhone(
  page: Page,
  origin: string | undefined,
  personId: string,
  body: { number: string; page?: string },
) {
  const answer = await page.request.post(`${E2E}/phones/${personId}`, {
    data: body,
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

/** "Find email"'s price as the panel shows it, from credits' price list. */
async function priceText(page: Page) {
  const answer = await page.request.get(`${API}/credits/prices`);
  expect(answer.status(), await answer.text()).toBe(200);
  const { prices } = (await answer.json()) as { prices: { action: string; credits: string }[] };
  const credits = Number(prices.find(({ action }) => action === "enrichment.work_email")?.credits);
  expect(Number.isFinite(credits)).toBe(true);
  return credits === 0
    ? t("ui.price.free")
    : t("ui.price.per_unit", { credits, unit: e("price_unit") });
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

const leadPath = (personId: string) => `/w/${WORKSPACE}/leads/${personId}`;
const panelOf = (page: Page) => page.getByRole("region", { name: e("title"), exact: true });

test("Find email: its price first, then Looking up… while the lookup is queued; once it ends, the address, its kind, class and date without a reload, and Verify again in its place, free; no vendor's name; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { find, suffix } = await seed(page, baseURL);
  const price = await priceText(page);
  await page.goto(leadPath(find));
  const panel = panelOf(page);
  await expect(panel).toContainText(e("not_looked_up"));
  const findButton = panel.getByRole("button", { name: e("find") });
  await expect(findButton).toBeEnabled();
  // The price before the button, in one place: the tag first.
  const tag = panel.locator(".wt-price-tag");
  await expect(tag).toHaveText(price);
  const order = await panel
    .locator(".wt-price-tag, button")
    .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  expect(order.slice(0, 2)).toEqual([price, e("find")]);
  await axe(page);

  await findButton.click();
  const looking = panel.getByRole("button", { name: e("looking_up") });
  await expect(looking).toBeDisabled();
  await axe(page);

  const address = `noor.find.${suffix}@corvid.example`;
  await endLookup(page, baseURL, find, { address });
  // The panel reads again every 3 seconds while the lookup works: well within its 60.
  await expect(panel).toContainText(address, { timeout: 10_000 });
  const kind = e("kind.work_email");
  await expect(panel).toContainText(e("provenance", { kind, source: e("source.email_finder") }));
  await expect(panel).toContainText(e("verified", { date: today() }));
  await expect(panel.getByRole("button", { name: e("verify_again") })).toBeEnabled();
  await expect(tag).toHaveCount(0);
  await expect(panel).not.toContainText(NAMES);
  await axe(page);
});

test("Verify again on a held address: no price; Looking up…; ended invalid, the verdict and the last lookup's reason; a personal address of a lead with no known country, not used and why; no vendor's name; axe on each", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { held, personal, suffix } = await seed(page, baseURL);
  const address = `noor.held.${suffix}@corvid.example`;
  await endLookup(page, baseURL, held, { address });
  await page.goto(leadPath(held));
  const panel = panelOf(page);
  await expect(panel).toContainText(address);
  const verify = panel.getByRole("button", { name: e("verify_again") });
  await expect(verify).toBeEnabled();
  await expect(panel.locator(".wt-price-tag")).toHaveCount(0);
  await verify.click();
  await expect(panel.getByRole("button", { name: e("looking_up") })).toBeDisabled();

  await endLookup(page, baseURL, held, { address, verdict: "invalid" });
  const checked = e("checked", { date: today(), verdict: e("verdict.invalid") });
  await expect(panel).toContainText(checked, { timeout: 10_000 });
  await expect(panel).toContainText(
    e("last_lookup", { date: today(), reason: e("reason.not_verified") }),
  );
  await expect(panel.getByRole("button", { name: e("verify_again") })).toBeEnabled();
  await expect(panel).not.toContainText(NAMES);
  await axe(page);

  const home = `noor.home.${suffix}@mail.example`;
  await endLookup(page, baseURL, personal, { address: home, kind: "personal_email" });
  await page.goto(leadPath(personal));
  await expect(panel).toContainText(home);
  await expect(panel).toContainText(e("kind.personal_email"));
  await expect(panel).toContainText(e("personal_needs_consent"));
  await expect(panel).not.toContainText(NAMES);
  await axe(page);
});

test("a lookup that ended without an address: no usable email, why, and Find email again; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { find } = await seed(page, baseURL);
  await endLookup(page, baseURL, find, { reason: "no_verifier_left" });
  await page.goto(leadPath(find));
  const panel = panelOf(page);
  await expect(panel).toContainText(e("no_address"));
  await expect(panel).toContainText(
    e("last_lookup", { date: today(), reason: e("reason.no_verifier_left") }),
  );
  await expect(panel.getByRole("button", { name: e("find") })).toBeEnabled();
  await axe(page);
});

test("a lead's phones: each number with the page that printed it as a link with no opener, one whose page was not kept, no address's words on them, and Find email still offered with a phone and no address; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const { phone, suffix } = await seed(page, baseURL);
  const printed = `https://acme-${suffix}.example/team`;
  // A number is on one person for good, so each run prints its own.
  const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const first = `+4822${digits()}`;
  const second = `+52551${digits()}`;
  await keepPhone(page, baseURL, phone, { number: first, page: printed });
  await keepPhone(page, baseURL, phone, { number: second });
  await page.goto(leadPath(phone));
  const panel = panelOf(page);
  await expect(panel.getByRole("heading", { name: e("phones_title") })).toBeVisible();
  await expect(panel).toContainText(first);
  await expect(panel).toContainText(second);
  const link = panel.getByRole("link", {
    name: e("phone_printed_on", { host: `acme-${suffix}.example` }),
  });
  await expect(link).toHaveAttribute("href", printed);
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(panel.getByRole("link")).toHaveCount(1);
  await expect(panel).toContainText(e("phone_no_page"));
  // A phone is no address: the panel still has none, and offers the lookup.
  await expect(panel).toContainText(e("not_looked_up"));
  await expect(panel.getByRole("button", { name: e("find") })).toBeEnabled();
  await expect(panel).not.toContainText(e("verify_again"));
  await expect(panel).not.toContainText(NAMES);
  await axe(page);
});

for (const zone of ["Asia/Kolkata", "UTC"]) {
  test.describe(`the browser in ${zone}`, () => {
    test.use({ timezoneId: zone });

    test(`a lookup ended at 00:30 in Kolkata reads the day it is in ${zone}, whatever the web server's zone`, async ({
      page,
      signInAs,
      baseURL,
    }) => {
      expect(dayIn(PAST_MIDNIGHT_IN_KOLKATA, "Asia/Kolkata")).not.toBe(
        dayIn(PAST_MIDNIGHT_IN_KOLKATA, "UTC"),
      );
      await signInAs();
      const { held, suffix } = await seed(page, baseURL);
      const address = `noor.zone.${suffix}@corvid.example`;
      await endLookup(page, baseURL, held, { address, at: PAST_MIDNIGHT_IN_KOLKATA });
      await page.goto(leadPath(held));
      const panel = panelOf(page);
      await expect(panel).toContainText(address);
      const date = dayIn(PAST_MIDNIGHT_IN_KOLKATA, zone);
      await expect(panel).toContainText(e("verified", { date }));
    });
  });
}
