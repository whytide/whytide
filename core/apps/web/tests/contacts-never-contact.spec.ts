// contacts' never-contact screen and one-click blocks end to end (beta-p2-020;
// core/modules/contacts/README.md "Screens"), in wsp_e2e_never_contact, this spec's alone, on two
// leads at one company and a third who opted out in a reply, which the e2e api's test-only module
// writes (core/apps/api/tests/fixtures/e2e), emptying the list first: the lead page's Never contact
// menu, its toast and the badge with its reason; the lead list's row menu, which opens no lead, a
// double click sending one request; the screen's rows and who added each, Remove after its
// confirmation, an opt-out without one; the form by a profile, a domain, and an opt-out after its
// confirmation, an invalid value's error under the field; the screen's loading, failed and empty
// states, through the e2e api's hold and fail cookies (tests/e2e-hold.ts). Every text from its key;
// axe on each state.
import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_never_contact";
const TEAMMATE = "e2e-usage@example.com";
const messages: Record<string, string> = { ...contacts, ...platform, ...ui };

/** The text of a key, its `{name}` placeholders filled; a key missing from the messages fails. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** A text as a pattern that matches it alone. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The badge's words for a reason: that branch of its select. */
function badge(reason: string): string {
  const branch = new RegExp(`\\b${reason} \\{([^}]*)\\}`).exec(say("contacts.never_contact.badge"));
  if (branch?.[1] === undefined) throw new Error(`no branch ${reason} in the badge`);
  return branch[1];
}

const COMPANY = { name: "Blue Harbor Labs", domain: "blueharbor.example" };
const qualified = (fitScore: number) => ({
  status: "qualified",
  fitScore,
  confidence: "high",
  tier: "hot",
});
const at = (slug: string, firstName: string, lastName: string, fitScore: number) => ({
  slug: `e2e-nc-${slug}`,
  firstName,
  lastName,
  title: "Head of Data",
  source: "imported",
  decision: qualified(fitScore),
});
/** Ada and Ben work at Blue Harbor Labs; Cleo, at none, answered "stop" to a message. */
const LEADS = [
  { ...at("ada", "Ada", "Harbor", 90), companyName: COMPANY.name, company: COMPANY },
  { ...at("ben", "Ben", "Harbor", 80), companyName: COMPANY.name, company: COMPANY },
  { ...at("cleo", "Cleo", "Stop", 70), optedOut: true },
];
const profile = (slug: string) => `https://linkedin.com/in/e2e-nc-${slug}`;

/** The workspace's leads, its never-contact list emptied, then Cleo's opt-out; their person ids. */
async function seed(page: Page, origin: string | undefined, leads: object[] = LEADS) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  return ((await answer.json()) as { personIds: string[] }).personIds;
}

/** Adds an entry through the api, as the signed-in user. */
async function block(page: Page, origin: string | undefined, body: object) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/contacts/suppression`, {
    data: body,
    headers: { origin: origin ?? "", "idempotency-key": randomUUID() },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
}

/** The e2e api holds (`e2e_hold`) or fails (`e2e_fail`) each read of a path ending so. */
const cookie = (context: BrowserContext, origin: string | undefined, name: string, path: string) =>
  context.addCookies([{ name, value: encodeURIComponent(path), url: origin ?? "" }]);
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const toast = (page: Page, key: string) => page.getByRole("status").filter({ hasText: say(key) });
/** The header's badge, in main: the streamed page waits in a hidden copy before React shows it. */
const badgeOf = (page: Page, reason: string) =>
  page.getByRole("main").getByText(badge(reason), { exact: true });
const rows = (page: Page) => page.locator("tbody tr");
const row = (page: Page, text: string) => rows(page).filter({ hasText: text });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });

/** Opens the menu, a native popover, until its item shows. */
async function open(trigger: Locator, item: Locator) {
  await expect(async () => {
    if (!(await item.isVisible())) await trigger.click({ timeout: 1_000 });
    await expect(item).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

/** Opens the menu and chooses the item; a click lost before the page hydrates is made again. */
async function choose(trigger: Locator, item: Locator, then: Locator) {
  await expect(async () => {
    if (await then.isVisible()) return;
    if (!(await item.isVisible())) await trigger.click({ timeout: 1_000 });
    await item.click({ timeout: 1_000 });
    await expect(then).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

/** Remove on the row, then the dialog's confirmation; the toast says it is done. */
async function remove(page: Page, who: string) {
  await button(page, say("contacts.never_contact.remove.label", { who })).click();
  const dialog = page.getByRole("dialog", {
    name: say("contacts.never_contact.remove.title", { who }),
  });
  await button(dialog, say("contacts.never_contact.remove.action")).click();
  await expect(toast(page, "contacts.never_contact.toast.removed")).toBeVisible();
}

test("the lead page's Never contact menu blocks the person, then their company, each with a toast and the badge; a person without a company has no Their company; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [ada, ben, cleo] = await seed(page, baseURL);
  const trigger = button(page, say("contacts.never_contact.menu.trigger"));
  const person = button(page, say("contacts.never_contact.menu.person"));
  const company = button(page, say("contacts.never_contact.menu.company"));

  await page.goto(`/w/${WORKSPACE}/leads/${ada}`);
  await expect(heading(page)).toHaveText("Ada Harbor");
  await expect(badgeOf(page, "never_contact_person")).toHaveCount(0);
  await choose(trigger, person, toast(page, "contacts.never_contact.toast.person"));
  await expect(badgeOf(page, "never_contact_person")).toBeVisible();
  await axe(page);
  // Their company: Ada's badge keeps her own reason, the first; Ben's page shows the company's.
  await choose(trigger, company, toast(page, "contacts.never_contact.toast.company"));
  await expect(badgeOf(page, "never_contact_person")).toBeVisible();
  await page.goto(`/w/${WORKSPACE}/leads/${ben}`);
  await expect(heading(page)).toHaveText("Ben Harbor");
  await expect(badgeOf(page, "never_contact_company")).toBeVisible();
  // Cleo opted out, and has no company to block.
  await page.goto(`/w/${WORKSPACE}/leads/${cleo}`);
  await expect(badgeOf(page, "opted_out")).toBeVisible();
  await open(trigger, person);
  await expect(company).toHaveCount(0);
  // The two entries on the screen, with Cleo's opt-out.
  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, profile("ada"))).toHaveCount(1);
  await expect(row(page, COMPANY.domain)).toHaveCount(1);
});

test("the screen lists the entries newest first with who added them; Remove after its confirmation lifts a block and the lead page's badge; an opt-out has no Remove; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const [ada, ben] = await seed(page, baseURL);
  await block(page, baseURL, { kind: "person", personId: ada });
  await block(page, baseURL, { kind: "company", value: COMPANY.domain });

  // Newest first: the company, Ada, then Cleo's opt-out, added by the system.
  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(heading(page)).toHaveText(say("contacts.never_contact.title"));
  const you = say("contacts.never_contact.added_by.you");
  const never = say("contacts.never_contact.list.blocklist");
  const removeText = say("contacts.never_contact.remove.action");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0).locator("th, td")).toHaveText([
    `${COMPANY.name} ${COMPANY.domain}`,
    say("contacts.never_contact.kind.company"),
    never,
    you,
    /\d/,
    removeText,
  ]);
  await expect(rows(page).nth(1).locator("th, td")).toHaveText([
    `Ada Harbor ${profile("ada")}`,
    say("contacts.never_contact.kind.person"),
    never,
    you,
    /\d/,
    removeText,
  ]);
  await expect(rows(page).nth(2).locator("th, td")).toHaveText([
    `Cleo Stop ${profile("cleo")}`,
    say("contacts.never_contact.kind.person"),
    say("contacts.never_contact.list.opt_out"),
    say("contacts.never_contact.added_by.system"),
    /\d/,
    "",
  ]);
  // An opt-out is never removed: its row has no button.
  await expect(row(page, profile("cleo")).getByRole("button")).toHaveCount(0);
  await axe(page);

  await button(page, say("contacts.never_contact.remove.label", { who: COMPANY.name })).click();
  const dialog = page.getByRole("dialog", {
    name: say("contacts.never_contact.remove.title", { who: COMPANY.name }),
  });
  await expect(dialog).toBeVisible();
  await axe(page);
  await button(dialog, say("ui.action.cancel")).click();
  await expect(dialog).toBeHidden();
  await expect(rows(page)).toHaveCount(3);
  await remove(page, COMPANY.name);
  await expect(rows(page)).toHaveCount(2);
  await page.goto(`/w/${WORKSPACE}/leads/${ben}`);
  await expect(heading(page)).toHaveText("Ben Harbor");
  await expect(badgeOf(page, "never_contact_company")).toHaveCount(0);

  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(rows(page)).toHaveCount(2);
  await remove(page, "Ada Harbor");
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`/w/${WORKSPACE}/leads/${ada}`);
  await expect(heading(page)).toHaveText("Ada Harbor");
  await expect(badgeOf(page, "never_contact_person")).toHaveCount(0);
});

test("the lead list's row menu blocks a company and a person without opening the lead; a double click sends one request; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/contacts/suppression")) {
      posts.push(request.postData() ?? "");
    }
  });
  const list = `/w/${WORKSPACE}/leads`;
  await page.goto(list);
  await expect(rows(page)).toHaveCount(3);
  const menuOf = (name: string) => button(page, say("contacts.leads.row_menu", { name }));
  const person = button(page, say("contacts.never_contact.row.person"));
  const company = button(page, say("contacts.never_contact.row.company"));

  await choose(menuOf("Ben Harbor"), company, toast(page, "contacts.never_contact.toast.company"));
  expect(new URL(page.url()).pathname).toBe(list);
  // Cleo has no company: her menu holds the person's item alone.
  await open(menuOf("Cleo Stop"), person);
  await expect(company).toHaveCount(0);
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(person).toBeHidden();

  // The page has hydrated: a double click on Ada's item sends one request.
  await menuOf("Ada Harbor").click();
  const before = posts.length;
  await person.dblclick();
  await expect(toast(page, "contacts.never_contact.toast.person")).toBeVisible();
  expect(posts.length - before).toBe(1);
  expect(new URL(page.url()).pathname).toBe(list);

  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(rows(page)).toHaveCount(3);
  await expect(row(page, profile("ada"))).toHaveCount(1);
  await expect(row(page, COMPANY.domain)).toHaveCount(1);
});

test("the screen adds a person by a profile and a company by a domain, an invalid value's error under the field, an opt-out after its confirmation and without Remove; who added each; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  // A teammate's entry, through the api.
  await signInAs(TEAMMATE);
  await seed(page, baseURL);
  await block(page, baseURL, { kind: "company", value: "teammate-nc.example" });
  await signInAs();

  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(rows(page)).toHaveCount(2);
  const addedBy = (text: string) => row(page, text).locator("td").nth(2);
  await expect(addedBy("teammate-nc.example")).toHaveText(
    say("contacts.never_contact.added_by.teammate"),
  );
  await expect(addedBy(profile("cleo"))).toHaveText(say("contacts.never_contact.added_by.system"));

  const form = page.getByRole("region", { name: say("contacts.never_contact.form.title") });
  const kind = form.getByLabel(say("contacts.never_contact.form.kind"), { exact: true });
  const layer = form.getByLabel(say("contacts.never_contact.form.list"), { exact: true });
  const personValue = form.getByLabel(say("contacts.never_contact.form.value_person"), {
    exact: true,
  });
  const companyValue = form.getByLabel(say("contacts.never_contact.form.value_company"), {
    exact: true,
  });
  const add = button(form, say("contacts.never_contact.form.add"));

  // A profile, in any case and form, kept normalized.
  await personValue.fill("https://www.linkedin.com/in/E2E-NC-New/");
  await add.click();
  await expect(toast(page, "contacts.never_contact.toast.added")).toBeVisible();
  await expect(row(page, profile("new"))).toHaveCount(1);
  await expect(personValue).toHaveValue("");

  // A domain, from a company's address.
  await kind.selectOption("company");
  await expect(layer).toHaveCount(0);
  await companyValue.fill("https://www.Acme-NC.example/about");
  await add.click();
  await expect(row(page, "acme-nc.example")).toHaveCount(1);
  await expect(addedBy("acme-nc.example")).toHaveText(say("contacts.never_contact.added_by.you"));

  // A value that is no profile, company page or domain: the api's error under the field.
  await companyValue.fill("not a domain");
  await add.click();
  const invalid = say("contacts.errors.suppression_target_invalid");
  await expect(form.getByText(invalid, { exact: true })).toBeVisible();
  await expect(companyValue).toHaveAttribute("aria-invalid", "true");
  await expect(companyValue).toHaveAccessibleDescription(new RegExp(escape(invalid)));
  await axe(page);
  await expect(rows(page)).toHaveCount(4);

  // An opt-out, recorded only after its confirmation, since it is never removed.
  await kind.selectOption("person");
  await layer.selectOption("opt_out");
  await personValue.fill("linkedin.com/in/e2e-nc-optout");
  await add.click();
  const confirm = page.getByRole("dialog", { name: say("contacts.never_contact.opt_out.title") });
  await expect(confirm).toContainText("linkedin.com/in/e2e-nc-optout");
  await axe(page);
  await button(confirm, say("ui.action.cancel")).click();
  await expect(confirm).toBeHidden();
  await expect(rows(page)).toHaveCount(4);
  await add.click();
  await button(confirm, say("contacts.never_contact.opt_out.confirm")).click();
  await expect(toast(page, "contacts.never_contact.toast.opted_out")).toBeVisible();
  const optedOut = row(page, profile("optout"));
  await expect(optedOut.locator("th, td")).toHaveText([
    profile("optout"),
    say("contacts.never_contact.kind.person"),
    say("contacts.never_contact.list.opt_out"),
    say("contacts.never_contact.added_by.you"),
    /\d/,
    "",
  ]);
  await expect(optedOut.getByRole("button")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(5);
});

test("the screen's states: loading while its read is held, a failed read in words with a retry, the empty list pointing to the leads; axe on each", async ({
  page,
  context,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await seed(page, baseURL, []);
  const path = "/contacts/suppression";
  await cookie(context, baseURL, "e2e_hold", path);
  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(heading(page)).toHaveText(say("contacts.never_contact.title"));
  await expect(
    page.getByRole("status").filter({ hasText: say("contacts.never_contact.loading") }),
  ).toBeVisible();
  await axe(page);
  await context.clearCookies({ name: "e2e_hold" });
  const empty = page.getByText(say("contacts.never_contact.empty"), { exact: true });
  await expect(empty).toBeVisible();
  await expect(
    page.getByRole("link", { name: say("contacts.never_contact.empty_link") }),
  ).toHaveAttribute("href", `/w/${WORKSPACE}/leads`);
  await axe(page);

  await cookie(context, baseURL, "e2e_fail", path);
  await page.reload();
  await expect(page.getByText(say("contacts.never_contact.error"), { exact: true })).toBeVisible();
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText(say("platform.error.generic"));
  await axe(page);
  await context.clearCookies({ name: "e2e_fail" });
  await button(alert, say("ui.action.retry")).click();
  await expect(empty).toBeVisible();
  await expect(alert).toHaveCount(0);
});
