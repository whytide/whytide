// The LinkedIn screen's reads today and window (alpha-p7-040, acceptance criterion 5, the screen's
// part; core/modules/linkedin README.md "Screen"), as e2e-usage@example.com, whose account no other
// spec touches: connected once through the fake's hosted link, its hours set so that today is no
// working day in UTC; the screen shows no reads of the 100 and the window closed until tomorrow's
// 08:30, as Intl writes it.
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const messages: Record<string, string> = linkedin;
type Account = { id: string; mine: boolean; status: string };

/** The text of a key, its arguments in place; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => values[name] ?? "");
}

test("the screen shows the reads today over the cap and the window closed, with the next start", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs("e2e-usage@example.com");
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
  const account = await mine();
  expect(account?.status).toBe("connected");
  const now = new Date();
  const tomorrow = (now.getUTCDay() % 7) + 1; // the ISO day after today's
  const data = {
    timeZone: "UTC",
    workingHours: { start: "08:30", end: "18:00", days: [tomorrow] },
  };
  expect(await page.request.patch(`${ACCOUNTS}/${account?.id}`, { data, headers })).toBeOK();

  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const usage = page.getByRole("region", { name: say("linkedin.usage.title"), exact: true });
  const reads = say("linkedin.usage.reads_today", { used: "0", cap: "100" });
  await expect(usage.getByText(reads)).toBeVisible();
  await expect(usage.getByText(say("linkedin.usage.window_closed"))).toBeVisible();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 8, 30);
  const options = { timeZone: "UTC", weekday: "long", hour: "2-digit", minute: "2-digit" } as const;
  const at = new Intl.DateTimeFormat("en", options).format(next);
  await expect(usage.getByText(say("linkedin.usage.next_window", { at }))).toBeVisible();
});
