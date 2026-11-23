// The LinkedIn screen's limits today and window (alpha-p7-040, acceptance criterion 5, the screen's
// part; beta-p1-020; core/modules/linkedin README.md "Screen"), as e2e-usage@example.com, whose
// account no other spec touches: connected once through the fake's hosted link, its hours set so
// that the account's day, as the usage route answers it, is no working day. The screen shows the
// reads, the connection requests and the messages today against their limits, the past week's
// connection requests and the actions, and the window closed until its next start, as Intl writes
// it. The values expected are the answer the screen itself got, never this test's clock, so a run
// across midnight UTC passes (alpha revisit).
import linkedin from "../../../modules/linkedin/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const messages: Record<string, string> = linkedin;
type Account = { id: string; mine: boolean; status: string };
type Budget = { used: number; limit: number };
type Usage = {
  quotaDay: string;
  cap: number;
  reserved: number;
  committed: number;
  windowOpen: boolean;
  nextWindowAt: string;
  readAllowance: number;
  invites: Budget;
  messages: Budget;
  weekInvites: { used: number; cap: number };
  actions: { used: number; max: number };
};

/** The text of a key, its arguments in place; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => `${values[name] ?? ""}`);
}

test("the screen shows the reads, connection requests and messages today against their limits, the week's connection requests, the actions, and the window closed, with the next start", async ({
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
    const data = {
      timeZone: "UTC",
      acknowledged: true,
      disclosureVersion: 2,
      personalAccount: true,
    };
    const { url } = await (
      await page.request.post(`${ACCOUNTS}/connect`, { data, headers })
    ).json();
    expect((await page.request.get(url, { maxRedirects: 0 })).status()).toBe(303);
  }
  const account = await mine();
  expect(account?.status).toBe("connected");
  const path = `${ACCOUNTS}/${account?.id}/usage`;
  // The ISO day after the account's day, as the route answers it: its only working day.
  const { quotaDay } = (await (await page.request.get(path)).json()) as Usage;
  const after = (new Date(`${quotaDay}T00:00:00Z`).getUTCDay() % 7) + 1;
  const data = {
    timeZone: "UTC",
    workingHours: { start: "08:30", end: "18:00", days: [after] },
  };
  expect(await page.request.patch(`${ACCOUNTS}/${account?.id}`, { data, headers })).toBeOK();

  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === path,
  );
  await page.goto(`/w/${WORKSPACE}/linkedin`);
  const usage = (await (await answered).json()) as Usage;
  // A fresh day of an account at the start: the default cap, the targets 5 and 10, nothing used.
  const reads = Math.min(usage.readAllowance, usage.cap);
  expect(reads).toBe(100);
  expect(usage.reserved + usage.committed).toBe(0);
  expect([4, 5]).toContain(usage.invites.limit);
  expect([8, 9, 10]).toContain(usage.messages.limit);
  expect([usage.invites.used, usage.messages.used]).toEqual([0, 0]);
  expect(usage.weekInvites).toEqual({ used: 0, cap: 100 });
  expect(usage.actions).toEqual({ used: 0, max: 200 });

  // The user's own account's, first: the e2e users are Owners of the fixture's workspace, whose
  // teammates' accounts follow their own (gamma-p6-070).
  const region = page
    .getByRole("region", { name: say("linkedin.usage.title"), exact: true })
    .first();
  const lines = [
    say("linkedin.usage.reads_today", { used: 0, cap: reads }),
    say("linkedin.usage.invites_today", usage.invites),
    say("linkedin.usage.messages_today", usage.messages),
    say("linkedin.usage.week_invites", usage.weekInvites),
    say("linkedin.usage.actions_today", usage.actions),
  ];
  for (const line of lines) await expect(region.getByText(line)).toBeVisible();

  // Closed: the account's day is no working day, or, past midnight, the working day before 08:30.
  expect(usage.windowOpen).toBe(false);
  await expect(region.getByText(say("linkedin.usage.window_closed"))).toBeVisible();
  const next = new Date(usage.nextWindowAt);
  expect([next.getUTCDay() || 7, next.getUTCHours(), next.getUTCMinutes()]).toEqual([after, 8, 30]);
  const options = { timeZone: "UTC", weekday: "long", hour: "2-digit", minute: "2-digit" } as const;
  const at = new Intl.DateTimeFormat("en", options).format(next);
  await expect(region.getByText(say("linkedin.usage.next_window", { at }))).toBeVisible();
});
