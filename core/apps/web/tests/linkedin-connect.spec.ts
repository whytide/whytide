// The LinkedIn screen end to end (alpha-p7-030, acceptance criteria 1 and 4; core/modules/linkedin
// README.md "Screen"), in a browser in Pacific/Auckland: the api refuses a connect without the
// acknowledgment of the current disclosure or without the personal-account box (beta-p1-070); on the
// screen, the disclosure's two boxes, Connect, the fake's hosted link and back, the account connected
// in the browser's zone; working hours saved and on the card again after a reload.
// The e2e api (core/apps/api/tests/e2e-server.ts) serves the fake's link, which the web's /api
// rewrite reaches, and posts the link's webhook to its own webhook route.
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const DEFAULT_HOURS = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] };
const messages: Record<string, string> = { ...linkedin, ...ui };

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string, item?: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return item === undefined ? value : value.replace("{item}", item);
}

test.use({ timezoneId: "Pacific/Auckland" });

test("connect after the disclosure, back connected in the browser's zone; working hours saved and shown", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const headers = { origin: baseURL ?? "" };
  // The e2e user's account from an earlier run, if any: default hours, then disconnected.
  const { accounts } = await (await page.request.get(ACCOUNTS)).json();
  for (const { id, mine, status } of accounts) {
    if (!mine) continue;
    const reset = { workingHours: DEFAULT_HOURS };
    expect(await page.request.patch(`${ACCOUNTS}/${id}`, { data: reset, headers })).toBeOK();
    if (status !== "disconnected") {
      expect(await page.request.delete(`${ACCOUNTS}/${id}`, { headers })).toBeOK();
    }
  }
  const timeZone = "Pacific/Auckland";
  const refusals = [
    [{ timeZone, acknowledged: false, disclosureVersion: 2, personalAccount: true }, "disclosure"],
    [{ timeZone, acknowledged: true }, "disclosure"], // alpha's body: no version
    [{ timeZone, acknowledged: true, disclosureVersion: 2 }, "personal_account"],
  ] as const;
  for (const [data, code] of refusals) {
    const refused = await page.request.post(`${ACCOUNTS}/connect`, { data, headers });
    expect([refused.status(), (await refused.json()).code]).toEqual([400, `${code}_required`]);
  }

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const connect = page.getByRole("button", { name: say("linkedin.connect.button") });
  await expect(connect).toBeDisabled();
  await page.getByRole("checkbox", { name: say("linkedin.connect.acknowledge") }).check();
  await expect(connect).toBeDisabled();
  await page.getByRole("checkbox", { name: say("linkedin.connect.personal_account") }).check();
  await connect.click();
  await page.waitForURL(`**/w/${WORKSPACE}/linkedin?connect=done`);
  const card = page.getByRole("region", { name: "LinkedIn", exact: true });
  const connected = say("linkedin.account.status.connected");
  await expect(card.getByText(connected, { exact: true })).toBeVisible();
  await expect(card.getByText("Pacific/Auckland", { exact: true })).toBeVisible();
  await expect(connect).toHaveCount(0);

  await card.getByLabel(say("linkedin.account.start")).selectOption("08:30");
  await card.getByLabel(say("linkedin.account.end")).selectOption("17:00");
  await card
    .getByRole("button", { name: say("ui.field.remove", say("linkedin.account.days.fri")) })
    .click();
  const days = card.getByRole("combobox", { name: say("linkedin.account.days_label") });
  await days.fill(say("linkedin.account.days.sat").slice(0, 3));
  await days.press("Enter");
  await card.getByRole("button", { name: say("linkedin.account.save") }).click();
  await expect(page.getByText(say("linkedin.account.saved"))).toBeVisible();

  await page.reload();
  await expect(card.getByLabel(say("linkedin.account.start"))).toHaveValue("08:30");
  await expect(card.getByLabel(say("linkedin.account.end"))).toHaveValue("17:00");
  const chips = card.getByRole("list", { name: say("linkedin.account.days_label") });
  const shown = ["mon", "tue", "wed", "thu", "sat"].map((day) =>
    say(`linkedin.account.days.${day}`),
  );
  await expect(chips.getByRole("listitem")).toHaveText(shown);
});
