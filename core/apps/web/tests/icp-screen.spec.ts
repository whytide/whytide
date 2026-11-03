// The ICP screen end to end (alpha-p4-050; core/modules/icp/README.md "The screen"), on the e2e api,
// which mounts icp beside its fixture module, in the fixture's one workspace. It lives here as icp's
// api test lives in the api's tests: a module's test never imports a host, sign-in.ts included. Each
// test first puts the ICP back through the api, with the default criteria, so none depends on another.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import icp from "../../../modules/icp/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const API = `/api/v1/workspaces/${WORKSPACE}/icp`;
const messages: Record<string, string> = { ...ui, ...icp };
const EMPTY = {
  name: "",
  titles: [],
  seniorities: [],
  industries: [],
  sizeRanges: [],
  countries: [],
  mustHaves: "",
  disqualifiers: "",
};
const DEFAULTS = [
  { key: "title_function", weight: 30, isMust: true, enabled: true },
  { key: "seniority", weight: 15, isMust: false, enabled: true },
  { key: "company_size", weight: 10, isMust: false, enabled: true },
  { key: "industry", weight: 15, isMust: false, enabled: true },
  { key: "location", weight: 10, isMust: true, enabled: true },
  { key: "must_haves", weight: 20, isMust: false, enabled: true },
];

/** The text of a key with its values put in; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const message = messages[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return message.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

type Fixtures = { page: Page; signInAs: () => Promise<void>; baseURL?: string };

/** Signs in, saves `start` and the default criteria through the api, opens the screen: the version. */
async function open({ page, signInAs, baseURL }: Fixtures, start = {}): Promise<number> {
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  const criteria = { criteria: DEFAULTS };
  expect((await page.request.put(`${API}/criteria`, { data: criteria, headers })).status()).toBe(
    200,
  );
  const answer = await page.request.put(API, { data: { ...EMPTY, ...start }, headers });
  expect(answer.status()).toBe(200);
  await page.goto(`/w/${WORKSPACE}/icp`);
  return ((await answer.json()) as { version: number }).version;
}

const textbox = (page: Page, key: string) =>
  page.getByRole("textbox", { name: say(key), exact: true });
const combobox = (page: Page, key: string) =>
  page.getByRole("combobox", { name: say(key), exact: true });
const chips = (page: Page, key: string) =>
  page.getByRole("list", { name: say(key), exact: true }).getByRole("listitem");
const criterion = (page: Page, key: string) =>
  page.getByRole("group", { name: say(`icp.criterion.${key}`), exact: true });
const weight = (page: Page, key: string) =>
  criterion(page, key).getByRole("textbox", { name: say("icp.screen.weight") });
const version = (page: Page, value: number) =>
  page.getByText(say("icp.screen.version", { version: value }), { exact: true });

/** Adds a chip of free text. */
async function add(page: Page, key: string, value: string): Promise<void> {
  await textbox(page, key).fill(value);
  await textbox(page, key).press("Enter");
}

/** Types into a closed list, checks that the option it would add is `label`, and adds it. */
async function pick(page: Page, key: string, typed: string, label: string): Promise<void> {
  await combobox(page, key).fill(typed);
  await expect(page.getByRole("option", { selected: true })).toHaveText(label);
  await combobox(page, key).press("Enter");
}

async function save(page: Page): Promise<void> {
  await page.getByRole("button", { name: say("ui.action.save") }).click();
  await expect(page.getByText(say("icp.screen.saved"), { exact: true })).toBeVisible();
}

test("every field filled and saved is there after a reload, with a bumped version; a new name alone keeps it", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const first = await open({ page, signInAs, baseURL });
  await expect(version(page, first)).toBeVisible();
  await textbox(page, "icp.screen.name").fill("EMEA mid-market");
  await add(page, "icp.screen.titles", "Head of Sales");
  await add(page, "icp.screen.industries", "Software");
  await pick(page, "icp.screen.seniorities", "dir", say("icp.seniority.director"));
  await pick(page, "icp.screen.size_ranges", "51", say("icp.size.from_51_to_200"));
  await pick(page, "icp.screen.countries", "fra", "France");
  await textbox(page, "icp.screen.must_haves").fill("Sells to other businesses");
  await textbox(page, "icp.screen.disqualifiers").fill("Agencies");
  await weight(page, "industry").fill("5");
  await weight(page, "seniority").fill("25");
  const [must, enabled] = [{ name: say("icp.screen.must") }, { name: say("icp.screen.enabled") }];
  await criterion(page, "location").getByRole("checkbox", must).uncheck();
  await criterion(page, "company_size").getByRole("checkbox", enabled).uncheck();
  await save(page);
  await expect(version(page, first + 1)).toBeVisible();

  await page.reload();
  await expect(version(page, first + 1)).toBeVisible();
  await expect(textbox(page, "icp.screen.name")).toHaveValue("EMEA mid-market");
  await expect(chips(page, "icp.screen.titles")).toHaveText(["Head of Sales"]);
  await expect(chips(page, "icp.screen.seniorities")).toHaveText([say("icp.seniority.director")]);
  await expect(chips(page, "icp.screen.industries")).toHaveText(["Software"]);
  await expect(chips(page, "icp.screen.size_ranges")).toHaveText([say("icp.size.from_51_to_200")]);
  await expect(chips(page, "icp.screen.countries")).toHaveText(["France"]);
  await expect(textbox(page, "icp.screen.must_haves")).toHaveValue("Sells to other businesses");
  await expect(textbox(page, "icp.screen.disqualifiers")).toHaveValue("Agencies");
  await expect(weight(page, "industry")).toHaveValue("5");
  await expect(weight(page, "seniority")).toHaveValue("25");
  await expect(criterion(page, "location").getByRole("checkbox", must)).not.toBeChecked();
  await expect(criterion(page, "company_size").getByRole("checkbox", enabled)).not.toBeChecked();

  await textbox(page, "icp.screen.name").fill("EMEA mid-market, renamed");
  await save(page);
  await page.reload();
  await expect(textbox(page, "icp.screen.name")).toHaveValue("EMEA mid-market, renamed");
  await expect(version(page, first + 1)).toBeVisible();
});

test("weights summing to 90 turn the sum red before saving, then show the translated error next to the table and change nothing", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const first = await open({ page, signInAs, baseURL });
  // The danger colour, as the kit's error text takes it from the tokens.
  const danger = await page.evaluate(() => {
    const probe = document.createElement("p");
    probe.className = "wt-field__error";
    document.body.append(probe);
    const { color } = getComputedStyle(probe);
    probe.remove();
    return color;
  });
  await expect(page.getByText(say("icp.screen.sum", { sum: 100 }))).not.toHaveCSS("color", danger);
  await weight(page, "industry").fill("5");
  await expect(page.getByText(say("icp.screen.sum", { sum: 90 }))).toHaveCSS("color", danger);
  await page.getByRole("button", { name: say("ui.action.save") }).click();
  const table = page.getByRole("region", { name: say("icp.screen.criteria") });
  await expect(table.getByText(say("icp.errors.icp_weights_must_sum_100"))).toBeVisible();

  await page.reload();
  await expect(weight(page, "industry")).toHaveValue("15");
  await expect(version(page, first)).toBeVisible();
  const stored = await page.request.get(`${API}/criteria`);
  expect(await stored.json()).toEqual({ criteria: DEFAULTS });
});

test("a title chip removed and saved is gone; the country picker finds Germany from ger and stores DE", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await open({ page, signInAs, baseURL }, { titles: ["Head of Sales", "CTO"] });
  await expect(chips(page, "icp.screen.titles")).toHaveText(["Head of Sales", "CTO"]);
  await page.getByRole("button", { name: say("ui.field.remove", { item: "CTO" }) }).click();
  await pick(page, "icp.screen.countries", "ger", "Germany");
  await save(page);

  await page.reload();
  await expect(chips(page, "icp.screen.titles")).toHaveText(["Head of Sales"]);
  await expect(chips(page, "icp.screen.countries")).toHaveText(["Germany"]);
  const stored = (await (await page.request.get(API)).json()) as Record<string, unknown>;
  expect([stored.titles, stored.countries]).toEqual([["Head of Sales"], ["DE"]]);
});

// axe (MPL-2.0) is a test-only devDependency of the web, as of the kit.
test("the screen passes axe, and its form is filled and saved with the keyboard alone", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await open({ page, signInAs, baseURL });
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  await textbox(page, "icp.screen.name").focus();
  await page.keyboard.type("Keyboard ICP");
  const entries: [ReturnType<typeof textbox>, string][] = [
    [textbox(page, "icp.screen.titles"), "VP Sales"],
    [combobox(page, "icp.screen.seniorities"), "vice"],
    [textbox(page, "icp.screen.industries"), "Fintech"],
    [combobox(page, "icp.screen.size_ranges"), "11 to"],
    [combobox(page, "icp.screen.countries"), "spa"],
  ];
  for (const [field, typed] of entries) {
    await page.keyboard.press("Tab");
    await expect(field).toBeFocused();
    await page.keyboard.type(typed);
    await page.keyboard.press("Enter");
  }
  for (const key of ["icp.screen.must_haves", "icp.screen.disqualifiers"]) {
    await page.keyboard.press("Tab");
    await expect(textbox(page, key)).toBeFocused();
    await page.keyboard.type("Typed with the keyboard");
  }
  await page.keyboard.press("Tab");
  await expect(weight(page, "title_function")).toBeFocused();
  await page.keyboard.press("Tab");
  const must = criterion(page, "title_function").getByRole("checkbox", {
    name: say("icp.screen.must"),
  });
  await expect(must).toBeFocused();
  await page.keyboard.press("Space");
  const button = page.getByRole("button", { name: say("ui.action.save") });
  for (let presses = 0; presses < 20; presses++) {
    if (await button.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(say("icp.screen.saved"), { exact: true })).toBeVisible();

  expect(await (await page.request.get(API)).json()).toMatchObject({
    name: "Keyboard ICP",
    titles: ["VP Sales"],
    seniorities: ["vp"],
    industries: ["Fintech"],
    sizeRanges: ["11-50"],
    countries: ["ES"],
    mustHaves: "Typed with the keyboard",
    disqualifiers: "Typed with the keyboard",
  });
  const { criteria } = (await (await page.request.get(`${API}/criteria`)).json()) as {
    criteria: unknown[];
  };
  expect(criteria[0]).toEqual({ ...DEFAULTS[0], isMust: false });
});
