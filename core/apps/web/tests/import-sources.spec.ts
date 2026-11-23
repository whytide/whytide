// The imports as sources, and each source's leads, end to end (csv-import-sources;
// core/modules/signals/README.md "Screen", core/modules/contacts/README.md "Screens"), on the e2e api
// in its import-sources workspace, this spec's alone (core/apps/api/tests/e2e-server.ts). A file
// uploaded and run through discovery's routes; the e2e api runs no worker, so the list's answer is
// the job as the worker leaves it (discovery.ts), and the leads it wrote, named by the file, come
// through the e2e api's test-only route. The Sources screen's Imported files card, its View leads,
// the list's chip and Clear, the lead page's way back in that view and its evidence panel naming the
// file; a post source's View leads; axe, and the Sources screen at a phone's width.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import { file, say as sayOf, workerWrites } from "./discovery.ts";
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2esources";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const FILE = "march-leads.csv";
const POST_LABEL = "Launch post e2e";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000077";
const CONNECTED = "Sources e2e, connected"; // the e2e api's seeded sender (e2e-signals.ts)
const signalsText: Record<string, string> = signals;

/** The text of a key of signals' or of discovery's helper's modules, with its values put in. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const message = signalsText[key];
  if (message === undefined) return sayOf(key, values);
  return message.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

/** A file of three profiles uploaded and run through discovery's routes: the job's id. */
async function importFile(page: Page, origin: string): Promise<string> {
  const rows = [1, 2, 3].map((n) => `https://www.linkedin.com/in/e2e-import-source-${n},P ${n},C`);
  const content = `linkedin_url,name,company\n${rows.join("\n")}\n`;
  const uploaded = await page.request.post(`${API}/discovery/imports`, {
    multipart: { file: file(FILE, content) },
    headers: { origin },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  const run = await page.request.post(`${API}/discovery/imports/${id}/run`, {
    headers: { origin },
  });
  expect(run.status(), await run.text()).toBe(202);
  return id;
}

/** The workspace's leads replaced: two of `source`, one of another import; their ids in order. */
async function seedLeads(page: Page, origin: string, source: Record<string, string>) {
  const qualified = (fitScore: number) => ({
    status: "qualified",
    fitScore,
    confidence: "high",
    tier: "hot",
  });
  const lead = (slug: string, lastName: string, fit: number, sources: object[]) => ({
    slug,
    firstName: "Source",
    lastName,
    source: "imported",
    sources,
    decision: qualified(fit),
  });
  const other = { kind: "imported", ref: "job_01K8E2E0000000000000000077" };
  const answer = await page.request.post(`${API}/e2e/leads`, {
    data: {
      leads: [
        lead("e2e-source-one", "One", 90, [source]),
        lead("e2e-source-two", "Two", 80, [other, source]),
        lead("e2e-source-other", "Other", 85, [other]),
      ],
    },
    headers: { origin },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

const names = (page: Page) => page.locator("tbody tr");
const chip = (page: Page) => page.getByText(/^Leads from /);

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("an import's card on the Sources screen with its counts; View leads opens the list of its leads with the chip, the lead page keeps the view and names the file, and Clear drops it; axe; a phone's width", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow();
  const origin = baseURL ?? "";
  await signInAs();
  const job = await importFile(page, origin);
  const counts = { created: 2, updated: 0, skippedDuplicate: 0, skippedErased: 0, errors: 1 };
  await workerWrites(page, job, { status: "done", counts, finishedAt: new Date().toISOString() });
  const [one, two] = await seedLeads(page, origin, { kind: "imported", ref: job, label: FILE });

  await page.goto(`/w/${WORKSPACE}/sources`);
  const imports = page.getByRole("region", { name: say("signals.imports.title") });
  const card = imports.getByRole("article", { name: FILE, exact: true }).first();
  await expect(card).toContainText(say("signals.imports.kind"));
  await expect(card).toContainText(say("signals.imports.status.done"));
  const fact = (key: string) =>
    card
      .getByRole("term")
      .filter({ hasText: new RegExp(`^${say(key)}$`) })
      .locator("xpath=following-sibling::dd[1]");
  await expect(fact("signals.imports.imported")).toHaveText("2");
  await expect(fact("signals.imports.skipped")).toHaveText("0");
  await expect(fact("signals.imports.errors")).toHaveText("1");
  await expect(fact("signals.imports.uploaded_by")).toHaveText(say("signals.imports.you"));
  const add = imports.getByRole("link", { name: say("signals.imports.import"), exact: true });
  await expect(add).toHaveAttribute("href", `/w/${WORKSPACE}/import`);
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForLoadState("networkidle");
  const wide = await page.evaluate(() => {
    const root = document.documentElement;
    const boxes: string[] = root.scrollWidth > root.clientWidth ? ["document"] : [];
    for (let box = document.querySelector("main"); box; box = box.parentElement) {
      if (box.scrollWidth > box.clientWidth) boxes.push(`${box.tagName} ${box.scrollWidth}`);
    }
    return boxes;
  });
  expect(wide).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });

  const view = card.getByRole("link", {
    name: say("signals.imports.view_leads_of", { file: FILE }),
  });
  await expect(view).toHaveText(say("signals.imports.view_leads"));
  await view.click();
  await page.waitForURL((url) => url.searchParams.get("source") === job);
  await expect(chip(page)).toHaveText(say("contacts.leads.source_filter.named", { source: FILE }));
  await expect(names(page)).toHaveText([/Source One/, /Source Two/]);
  // Every status, the filter's All; the Source column names the file.
  const status = page.getByLabel(say("contacts.leads.filter.status"), { exact: true });
  await expect(status).toHaveValue("");
  await expect(status.locator("option:checked")).toHaveText(say("contacts.leads.status.all"));
  const importedFrom = say("contacts.leads.source.imported_from", { file: FILE });
  await expect(names(page).first()).toContainText(importedFrom);
  const pills = page.getByRole("list", { name: say("contacts.leads.counts_label") });
  const qualified = say("contacts.leads.status.qualified");
  const qualifiedPill = pills
    .getByRole("listitem")
    .filter({ hasText: new RegExp(`^${qualified}`) });
  await expect(qualifiedPill).toHaveText(`${qualified} 2`);
  await expect(pills.locator("[aria-current]")).toHaveCount(0);
  await expectNoSeriousViolation(page);

  // The lead page keeps the view: its way back and its next lead are the source's.
  await page.locator("tbody tr a").first().press("Enter");
  await page.waitForURL((url) => url.pathname === `/w/${WORKSPACE}/leads/${one}`);
  const around = page.getByRole("navigation", { name: say("contacts.lead.navigation") });
  const inView = `?sort=fit&source=${job}`;
  await expect(around.getByRole("link", { name: say("contacts.lead.back") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/leads${inView}`,
  );
  await expect(around.getByRole("link", { name: say("contacts.lead.next") })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/leads/${two}${inView}`,
  );
  const evidence = page.getByRole("region", { name: say("signals.evidence.title") });
  await expect(
    evidence.getByText(say("signals.evidence.imported_from", { file: FILE }), { exact: true }),
  ).toBeVisible();

  await around.getByRole("link", { name: say("contacts.lead.back") }).click();
  await page.waitForURL((url) => url.searchParams.get("source") === job);
  await page
    .getByRole("link", { name: say("contacts.leads.source_filter.clear"), exact: true })
    .click();
  await page.waitForURL(
    (url) => url.pathname.endsWith("/leads") && !url.searchParams.has("source"),
  );
  await expect(chip(page)).toHaveCount(0);
  await expect(names(page)).toHaveText([/Source One/, /Source Other/, /Source Two/]);
  await expect(pills.locator("[aria-current]")).toHaveText(`${qualified} 3`);
});

test("an import whose leads are all pending shows them after View leads, every status; a status chosen filters, and the address keeps it", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow();
  const origin = baseURL ?? "";
  await signInAs();
  const job = await importFile(page, origin);
  const counts = { created: 2, updated: 0, skippedDuplicate: 1, skippedErased: 0, errors: 0 };
  await workerWrites(page, job, { status: "done", counts, finishedAt: new Date().toISOString() });
  const source = { kind: "imported", ref: job, label: FILE };
  const pending = (slug: string, lastName: string) => ({
    ...{ slug, firstName: "Pending", lastName, source: "imported", sources: [source] },
  });
  const seeded = await page.request.post(`${API}/e2e/leads`, {
    data: { leads: [pending("e2e-pending-one", "One"), pending("e2e-pending-two", "Two")] },
    headers: { origin },
  });
  expect(seeded.status(), await seeded.text()).toBe(200);

  await page.goto(`/w/${WORKSPACE}/sources`);
  const card = page
    .getByRole("region", { name: say("signals.imports.title") })
    .getByRole("article", { name: FILE, exact: true })
    .first();
  const fact = (key: string) =>
    card
      .getByRole("term")
      .filter({ hasText: new RegExp(`^${say(key)}$`) })
      .locator("xpath=following-sibling::dd[1]");
  await expect(fact("signals.imports.skipped")).toHaveText("1");
  await expect(
    card.getByRole("term").filter({ hasText: say("signals.imports.errors") }),
  ).toHaveCount(0);
  await card
    .getByRole("link", { name: say("signals.imports.view_leads_of", { file: FILE }) })
    .click();
  await page.waitForURL((url) => url.searchParams.get("source") === job);
  await expect(names(page)).toHaveCount(2);
  await expect(names(page).first()).toContainText(/Pending/);
  await expect(chip(page)).toHaveText(say("contacts.leads.source_filter.named", { source: FILE }));

  const status = page.getByLabel(say("contacts.leads.filter.status"), { exact: true });
  await status.selectOption("qualified");
  await page.waitForURL((url) => url.searchParams.get("status") === "qualified");
  expect(new URL(page.url()).searchParams.get("source")).toBe(job);
  await expect(page.getByText(say("contacts.leads.empty.status"))).toBeVisible();
  await status.selectOption("");
  await page.waitForURL((url) => !url.searchParams.has("status"));
  await expect(names(page)).toHaveCount(2);
});

test("a post source's View leads opens the list of its leads with its label in the chip; the Import screen's past import links to its leads", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow();
  const origin = baseURL ?? "";
  await signInAs();
  const { accounts } = await (await page.request.get(`${API}/linkedin/accounts`)).json();
  const sender = accounts.find((one: { label: string }) => one.label === CONNECTED);
  expect(sender, "the api on API_PORT is not serve:e2e").toBeTruthy();
  const { sources } = await (await page.request.get(`${API}/signals/sources`)).json();
  for (const { id } of sources) {
    expect(
      await page.request.delete(`${API}/signals/sources/${id}`, { headers: { origin } }),
    ).toBeOK();
  }
  const added = await page.request.post(`${API}/signals/sources`, {
    data: {
      kind: "post_engagers",
      config: { postUrl: POST },
      label: POST_LABEL,
      senderAccountId: sender.id,
    },
    headers: { origin },
  });
  expect(added.status(), await added.text()).toBe(201);
  const { id: sourceId } = (await added.json()) as { id: string };
  await seedLeads(page, origin, { kind: "signal", ref: sourceId, label: POST_LABEL, url: POST });

  await page.goto(`/w/${WORKSPACE}/sources`);
  const card = page.getByRole("article", { name: POST_LABEL, exact: true });
  const view = card.getByRole("link", {
    name: say("signals.sources.view_leads_of", { label: POST_LABEL }),
  });
  await expect(view).toHaveAttribute("href", `/w/${WORKSPACE}/leads?source=${sourceId}`);
  await view.click();
  await page.waitForURL((url) => url.searchParams.get("source") === sourceId);
  await expect(chip(page)).toHaveText(
    say("contacts.leads.source_filter.named", { source: POST_LABEL }),
  );
  await expect(names(page)).toHaveText([/Source One/, /Source Two/]);

  // The Import screen: the job among the past imports links to its leads.
  const job = await importFile(page, origin);
  const counts = { created: 1, updated: 1, skippedDuplicate: 0, skippedErased: 0, errors: 1 };
  await workerWrites(page, job, { status: "done", counts, finishedAt: new Date().toISOString() });
  await page.goto(`/w/${WORKSPACE}/import`);
  const history = page.getByRole("table", { name: say("discovery.import.history.title") });
  const link = history.getByRole("link", {
    name: say("discovery.import.history.view_leads_of", { file: FILE }),
  });
  await expect(link.first()).toHaveAttribute("href", `/w/${WORKSPACE}/leads?source=${job}`);
  await expect(link.first()).toHaveText(say("discovery.import.view_leads"));
});
