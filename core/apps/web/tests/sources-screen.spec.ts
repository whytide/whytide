// The sources screen end to end (alpha-p8-040; core/modules/signals README.md "Screen"): a post
// source added from the form, listed with its three next fire times; the inline errors of a URL that
// is not a post's and of the eleventh enabled source; the runs panel of factory-seeded runs, its
// card the current one; the warning on a source whose account is not connected; disabling hides the
// fire times, deleting asks first; every text from its key, and axe. The sender accounts are the two the e2e api seeds
// (core/apps/api/tests/e2e-signals.ts), never the e2e user's own, which linkedin-connect.spec.ts
// disconnects and connects again; the runs come through the e2e api's test-only route.
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const SCREEN = `/w/${WORKSPACE}/sources`;
const SOURCES = `/api/v1/workspaces/${WORKSPACE}/signals/sources`;
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const SEED_RUNS = `http://127.0.0.1:${process.env.API_PORT}/test/signals/runs`;
const CONNECTED = "Sources e2e, connected"; // the labels of the e2e api's seeded accounts
const DISCONNECTED = "Sources e2e, disconnected";
const DAY_MS = 86_400_000;
const messages: Record<string, string> = { ...signals, ...ui };

/** The text of a key with its values; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

/** A LinkedIn post's URL of its own for each `n` below 100. */
const post = (n: number) =>
  `https://www.linkedin.com/feed/update/urn:li:activity:72500000000000000${String(n).padStart(2, "0")}`;

/** The list's card of the source with the label: an article its heading names. */
const row = (page: Page, label: string) => page.getByRole("article", { name: label, exact: true });

/** Every source of the workspace deleted through the api: an earlier run may have left some. */
async function reset(page: Page, origin: string): Promise<void> {
  const { sources } = await (await page.request.get(SOURCES)).json();
  for (const { id } of sources) {
    expect(await page.request.delete(`${SOURCES}/${id}`, { headers: { origin } })).toBeOK();
  }
}

async function accountId(page: Page, label: string): Promise<string> {
  const { accounts } = await (await page.request.get(ACCOUNTS)).json();
  const account = accounts.find((one: { label: string }) => one.label === label);
  if (!account) throw new Error(`no account ${label}: the api on API_PORT is not serve:e2e`);
  return account.id;
}

async function addSource(page: Page, origin: string, label: string, sender: string, n: number) {
  const body = {
    kind: "post_engagers",
    config: { postUrl: post(n) },
    label,
    senderAccountId: sender,
  };
  const answer = await page.request.post(SOURCES, { data: body, headers: { origin } });
  expect(answer.status()).toBe(201);
  return answer.json();
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("a post source added from the form is listed with its three next fire times; a URL that is not a post's and the eleventh enabled source show their errors inline", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  await page.goto(SCREEN);
  await expect(page.getByText(say("signals.sources.empty"))).toBeVisible();

  const form = page.getByRole("form", { name: say("signals.sources.add_title") });
  const url = form.getByLabel(say("signals.sources.post_url"));
  const label = form.getByLabel(say("signals.sources.label"), { exact: true });
  const add = form.getByRole("button", { name: say("signals.sources.add") });
  await url.fill("https://www.linkedin.com/in/example-author/");
  await label.fill("Launch post");
  await form.getByLabel(say("signals.sources.account")).selectOption({ label: CONNECTED });
  await add.click();
  await expect(form.getByText(say("signals.errors.signal_config_invalid"))).toBeVisible();
  await expect(url).toHaveAttribute("aria-invalid", "true");

  await url.fill(post(1));
  await add.click();
  const launch = row(page, "Launch post");
  await expect(launch).toContainText(CONNECTED);
  const [source] = (await (await page.request.get(SOURCES)).json()).sources;
  const saved = Date.parse(source.createdAt);
  const fireTimes = [0, 3, 7].map((days) => new Date(saved + days * DAY_MS).toISOString());
  expect([source.fireTimes, source.nextRunAt]).toEqual([fireTimes, fireTimes[0]]);
  const times = launch.getByRole("listitem").locator("time");
  await expect(times).toHaveCount(3);
  const shown = await times.evaluateAll((all) => all.map((time) => time.getAttribute("datetime")));
  expect(shown).toEqual(fireTimes);
  await expect(launch).not.toContainText(say("signals.sources.account_disconnected"));

  const sender = await accountId(page, CONNECTED);
  for (let n = 2; n <= 10; n++) await addSource(page, origin, `Post ${n}`, sender, n);
  await page.reload();
  await url.fill(post(11));
  await label.fill("Post 11");
  await form.getByLabel(say("signals.sources.account")).selectOption({ label: CONNECTED });
  await add.click();
  await expect(form.getByRole("alert")).toContainText(say("signals.errors.signal_sources_limit"));
  await expectNoSeriousViolation(page);
});

test("the runs panel shows the seeded runs with status and counts, a failed run's error in words and when a waiting run resumes, its source's card the current one; a source whose account is not connected warns", async ({
  page,
  signInAs,
  baseURL,
  request,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const read = await addSource(page, origin, "Read post", await accountId(page, CONNECTED), 21);
  await addSource(page, origin, "Orphan post", await accountId(page, DISCONNECTED), 22);
  const done = {
    status: "done",
    startedAt: "2026-10-20T09:00:00.000Z",
    finishedAt: "2026-10-20T09:04:00.000Z",
    counts: { staged: 95, created: 12 },
  };
  const runs = [
    done,
    {
      status: "failed",
      startedAt: "2026-10-21T09:00:00.000Z",
      finishedAt: "2026-10-21T09:01:00.000Z",
      error: "linkedin_account_disconnected",
    },
    { status: "waiting", startedAt: "2026-10-22T09:00:00.000Z", counts: { staged: 30 } },
  ];
  const seeded = await request.post(SEED_RUNS, { data: { sourceId: read.id, runs } });
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);

  await page.goto(SCREEN);
  const warning = say("signals.sources.account_disconnected");
  await expect(row(page, "Orphan post")).toContainText(warning);
  await expect(row(page, "Read post")).not.toContainText(warning);
  const title = say("signals.runs.title", { label: "Read post" });
  await row(page, "Read post").getByRole("link", { name: title }).click();
  const panel = page.getByRole("region", { name: title });
  // The card whose runs show is marked for assistive technology too, not by its ring alone.
  await expect(row(page, "Read post")).toHaveAttribute("aria-current", "true");
  await expect(row(page, "Orphan post")).not.toHaveAttribute("aria-current");
  const run = (status: string) =>
    panel.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: say(`signals.runs.status.${status}`) }),
    });
  await expect(run("done")).toContainText(say("signals.runs.counts", { staged: 95, created: 12 }));
  await expect(run("done").locator("time")).toHaveCount(2);
  await expect(run("done").locator("time").first()).toHaveAttribute("datetime", done.startedAt);
  await expect(run("failed")).toContainText(say("signals.errors.linkedin_account_disconnected"));
  // When it reads again: the sender account's next working hours, as linkedin's usage answers them.
  const usage = await (await page.request.get(`${ACCOUNTS}/${read.senderAccountId}/usage`)).json();
  for (const words of signals["signals.runs.waiting_until"].split("<time>{at}</time>")) {
    await expect(run("waiting")).toContainText(words);
  }
  await expect(run("waiting").locator(`time[datetime="${usage.nextWindowAt}"]`)).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("disabling a source hides its next fire times; deleting it asks first, then removes it", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  await addSource(page, origin, "Pause me", await accountId(page, CONNECTED), 31);
  await page.goto(SCREEN);
  const source = row(page, "Pause me");
  await expect(source.locator("time")).toHaveCount(3);
  const name = say("signals.sources.enabled_switch", { label: "Pause me" });
  await source.getByRole("switch", { name }).uncheck();
  await expect(source.getByText(say("signals.sources.paused"))).toBeVisible();
  await expect(source.locator("time")).toHaveCount(0);
  const [disabled] = (await (await page.request.get(SOURCES)).json()).sources;
  expect(disabled).toMatchObject({ enabled: false, fireTimes: [], nextRunAt: null });

  await source.getByRole("button", { name: say("signals.sources.delete") }).click();
  const title = say("signals.sources.delete_title", { label: "Pause me" });
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toContainText(say("signals.sources.delete_confirm"));
  await dialog.getByRole("button", { name: say("signals.sources.delete") }).click();
  await expect(source).toHaveCount(0);
  await expect(page.getByText(say("signals.sources.empty"))).toBeVisible();
  expect((await (await page.request.get(SOURCES)).json()).sources).toEqual([]);
});
