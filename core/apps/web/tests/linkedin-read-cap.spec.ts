// The LinkedIn screen's daily read limit (fix-read-cap, criterion 5; core/modules/linkedin README.md
// "Screen"), as e2e-read-cap@example.com, whose account no other spec touches: connected once through
// the fake's hosted link and set back to the default cap first. The warning and the bound show; a
// limit above the bound is refused under the field and stores nothing; one inside it saves and is the
// cap of the reads today and of the card; a member without linkedin.manage, which the account's
// canManage says (alpha's can() never does: here through Playwright's routing), sees the value only.
// Every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const EMAIL = "e2e-read-cap@example.com";
const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const messages: Record<string, string> = linkedin;
type Account = { id: string; mine: boolean; status: string; canManage: boolean };

/** The text of a key, its arguments in place; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => values[name] ?? "");
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("the daily read limit: the warning and the bound, a refusal under the field, then a limit saved; without linkedin.manage, the value only", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs(EMAIL);
  const headers = { origin: baseURL ?? "" };
  const mine = async () => {
    const { accounts } = await (await page.request.get(ACCOUNTS)).json();
    return (accounts as Account[]).find((account) => account.mine);
  };
  if ((await mine())?.status !== "connected") {
    const data = { timeZone: "UTC", acknowledged: true };
    const { url } = await (
      await page.request.post(`${ACCOUNTS}/connect`, { data, headers })
    ).json();
    expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
  }
  const id = (await mine())?.id;
  const reset = { dailyReadCap: 100 };
  expect(await page.request.patch(`${ACCOUNTS}/${id}`, { data: reset, headers })).toBeOK();
  const { capMax } = await (await page.request.get(`${ACCOUNTS}/${id}/usage`)).json();

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const card = page.getByRole("region", { name: "LinkedIn", exact: true });
  const usage = page.getByRole("region", { name: say("linkedin.usage.title"), exact: true });
  const field = usage.getByRole("textbox", { name: say("linkedin.account.cap_label") });
  await expect(field).toHaveValue("100");
  await expect(
    usage.getByText(say("linkedin.read_limit.hint", { max: `${capMax}` })),
  ).toBeVisible();
  await expect(usage.getByText(say("linkedin.read_limit.warning"))).toBeVisible();

  const save = usage.getByRole("button", { name: say("linkedin.read_limit.save") });
  await field.fill(`${capMax + 1}`);
  await save.click();
  await expect(usage.getByText(say("linkedin.errors.read_cap_invalid"))).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  expect((await (await page.request.get(ACCOUNTS)).json()).accounts).toContainEqual(
    expect.objectContaining({ id, dailyReadCap: 100 }),
  );
  await expectNoSeriousViolation(page);

  await field.fill("150");
  await save.click();
  await expect(usage.getByText(say("linkedin.read_limit.saved"))).toBeVisible();
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await expect(
    usage.getByText(say("linkedin.usage.reads_today", { used: "0", cap: "150" })),
  ).toBeVisible();
  await expect(card.getByText(say("linkedin.account.cap", { cap: "150" }))).toBeVisible();
  await expectNoSeriousViolation(page);

  await page.route(`**${ACCOUNTS}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const account of json.accounts as Account[]) account.canManage = false;
    await route.fulfill({ response, json });
  });
  await page.reload();
  await expect(card.getByText(say("linkedin.account.cap", { cap: "150" }))).toBeVisible();
  await expect(
    usage.getByText(say("linkedin.usage.reads_today", { used: "0", cap: "150" })),
  ).toBeVisible();
  await expect(usage.getByRole("textbox")).toHaveCount(0);
});
