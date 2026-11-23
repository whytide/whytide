// contacts' exclusion lists on the never-contact screen end to end (gamma-p2-045;
// core/modules/contacts/README.md "Screens"), in wsp_e2e_exclusions, this spec's alone, its entries
// and lists emptied first by the e2e api's test-only module (core/apps/api/tests/fixtures/e2e): an
// Owner imports a file by keyboard, reads what it added and the rows without an entry by number,
// finds the list and its companies on the never-contact list, then removes the list by keyboard
// after its confirmation; a Member sees the card and the lists without Remove, a refused file in
// words, and imports a list of their own. Every text from its key; axe on each state.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_exclusions";
/** A Member of this workspace, no Owner (core/apps/api/tests/e2e-server.ts). */
const MEMBER = "e2e-member@example.com";
const messages: Record<string, string> = { ...contacts, ...platform, ...ui };

/** The text of a key: `{name}` filled, and in English each plural for its number, `#` the number. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  const plurals = value.replace(
    /\{(\w+), plural, ((?:[=\w]+ \{[^}]*\} ?)+)\}/g,
    (_, name: string, branches: string) => {
      const n = Number(values[name]);
      const forms = new Map(
        [...branches.matchAll(/([=\w]+) \{([^}]*)\}/g)].map(([, k, v]) => [k, v]),
      );
      return (forms.get(`=${n}`) ?? forms.get(n === 1 ? "one" : "other") ?? "").replace(
        /#/g,
        `${n}`,
      );
    },
  );
  return plurals.replace(/\{(\w+)\}/g, (whole, name: string) => `${values[name] ?? whole}`);
}

const file = (name: string, content: string) => ({
  name,
  mimeType: "text/csv",
  buffer: Buffer.from(content),
});
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const cells = (row: Locator) => row.locator("th, td");
const card = (page: Page) => page.getByRole("region", { name: say("contacts.exclusions.title") });
const lists = (page: Page) =>
  card(page)
    .getByRole("table", { name: say("contacts.exclusions.caption") })
    .locator("tbody tr");
const entries = (page: Page) =>
  page.getByRole("table", { name: say("contacts.never_contact.caption") }).locator("tbody tr");
const picker = (page: Page) =>
  card(page).getByLabel(say("contacts.exclusions.file"), { exact: true });
const outcome = (page: Page, added: number, duplicates: number, invalid: number) =>
  card(page).getByText(say("contacts.exclusions.result", { added, duplicates, invalid }), {
    exact: true,
  });

/** The workspace's never-contact entries and exclusion lists emptied, as the signed-in user. */
async function reset(page: Page, origin: string | undefined) {
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: [] },
    headers: { origin: origin ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("an Owner imports a CSV of competitors by keyboard: what it added, the rows without an entry by number, the list, its companies on the never-contact list; Remove by keyboard after its confirmation marks the list removed and lifts them; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await reset(page, baseURL);
  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(
    card(page).getByText(say("contacts.exclusions.empty"), { exact: true }),
  ).toBeVisible();
  await axe(page);

  const kind = card(page).getByLabel(say("contacts.exclusions.relationship"), { exact: true });
  // The card's first control, then the keyboard alone: Tab to the file, Tab to Import, Enter.
  await kind.focus();
  await kind.selectOption("competitor");
  await page.keyboard.press("Tab");
  await expect(picker(page)).toBeFocused();
  const csv =
    "domain\nrival-one.example\n=1+1\nRIVAL-ONE.example\nhttps://www.rival-two.example/\n";
  await picker(page).setInputFiles(file("rivals.csv", csv));
  await page.keyboard.press("Tab");
  await expect(button(card(page), say("contacts.exclusions.submit"))).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(outcome(page, 2, 1, 1)).toBeVisible();
  await expect(card(page).getByRole("listitem")).toHaveText([
    say("contacts.exclusions.row.domain_invalid", { row: 3 }),
    say("contacts.exclusions.row.duplicate", { row: 4 }),
  ]);
  await expect(lists(page)).toHaveCount(1);
  const competitor = say("contacts.never_contact.relationship.competitor");
  const you = say("contacts.never_contact.added_by.you");
  const remove = say("contacts.exclusions.remove.action");
  // The file, its kind, the companies added, who added it, the date, Remove.
  await expect(cells(lists(page).first())).toHaveText([
    "rivals.csv",
    competitor,
    "2",
    you,
    /\d/,
    remove,
  ]);
  await expect(entries(page)).toHaveCount(2);
  await expect(entries(page).filter({ hasText: "rival-two.example" })).toHaveCount(1);
  await axe(page);

  await button(card(page), say("contacts.exclusions.remove.label", { name: "rivals.csv" })).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: say("contacts.exclusions.remove.title", { name: "rivals.csv" }),
  });
  await expect(dialog.getByText(say("contacts.exclusions.remove.body"))).toBeVisible();
  await axe(page);
  await button(dialog, say("contacts.exclusions.remove.action")).focus();
  await page.keyboard.press("Enter");
  const toast = say("contacts.exclusions.toast.removed");
  await expect(page.getByRole("status").filter({ hasText: toast })).toBeVisible();
  await expect(cells(lists(page).first()).nth(0)).toHaveText(
    `rivals.csv ${say("contacts.exclusions.removed")}`,
  );
  await expect(lists(page).getByRole("button")).toHaveCount(0);
  await expect(page.getByText(say("contacts.never_contact.empty"), { exact: true })).toBeVisible();
  await axe(page);
});

test("a Member sees the card and the lists without Remove, a refused file in words, and imports a list of their own; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  await reset(page, baseURL);
  const owners = await page.request.post(
    `/api/v1/workspaces/${WORKSPACE}/contacts/exclusions/imports?relationship=customer`,
    {
      multipart: { file: file("customers.csv", "domain\nowner-customer.example\n") },
      headers: { origin: baseURL ?? "" },
    },
  );
  expect(owners.status(), await owners.text()).toBe(201);
  await signInAs(MEMBER);
  await page.goto(`/w/${WORKSPACE}/never-contact`);
  await expect(lists(page)).toHaveCount(1);
  // The viewer is known once "added by" names the Owner's list a teammate's.
  await expect(cells(lists(page).first()).nth(3)).toHaveText(
    say("contacts.never_contact.added_by.teammate"),
  );
  const removeHeader = say("contacts.never_contact.columns.remove");
  await expect(card(page).getByRole("columnheader", { name: removeHeader })).toHaveCount(0);
  await expect(lists(page).getByRole("button")).toHaveCount(0);

  const submit = button(card(page), say("contacts.exclusions.submit"));
  await picker(page).setInputFiles(file("websites.csv", "website\nmember.example\n"));
  await submit.click();
  const refused = say("contacts.errors.exclusions_missing_column");
  await expect(card(page).getByText(refused, { exact: true })).toBeVisible();
  await expect(lists(page)).toHaveCount(1);
  await axe(page);

  await picker(page).setInputFiles(file("members.csv", "domain\nmember-customer.example\n"));
  await submit.click();
  await expect(outcome(page, 1, 0, 0)).toBeVisible();
  await expect(card(page).getByText(refused, { exact: true })).toHaveCount(0);
  await expect(lists(page)).toHaveCount(2);
  await expect(cells(lists(page).first()).nth(0)).toHaveText("members.csv");
  await expect(cells(lists(page).first()).nth(3)).toHaveText(
    say("contacts.never_contact.added_by.you"),
  );
  await expect(lists(page).getByRole("button")).toHaveCount(0);
  await axe(page);
});
