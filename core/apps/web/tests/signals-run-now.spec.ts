// The sources screen's Run now and its runs panel (alpha-p10-110; core/modules/signals/README.md
// "Screen") in wsp_e2e_run_now, this spec's alone, on the e2e api's two sender accounts there and the
// runs its test-only route seeds (core/apps/api/tests/e2e-signals.ts). Run now asks the api, which
// answers 202 with the run, scheduled: the e2e servers start no worker, so the run stays scheduled
// (core/apps/api/tests/signals-sources.test.ts and core/apps/worker/tests/signals-schedule.test.ts
// prove the start). A run opened since the list was read is the api's 409 in words, then Run now is
// disabled, as for a waiting run; a run's drops by reason and its end codes in words; a blocked source
// links to the LinkedIn screen. While a run is open, the line under Run now says why, on linkedin's
// usage stubbed through page.route, its reads counted (fix-run-wait), and Stop beside it asks the api
// to stop the run, which stays open with no worker, its stop asked (fix-run-stop). After Run now, the
// list is read again until its run starts, a running run seeded beside it on the page's clock moved
// on. Every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { APIRequestContext, Page, Request } from "@playwright/test";
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_run_now"; // the e2e api's RUN_NOW_WORKSPACE
const SCREEN = `/w/${WORKSPACE}/sources`;
const SOURCES = `/api/v1/workspaces/${WORKSPACE}/signals/sources`;
const ACCOUNTS = `/api/v1/workspaces/${WORKSPACE}/linkedin/accounts`;
const SEED_RUNS = `http://127.0.0.1:${process.env.API_PORT}/test/signals/runs`;
const CONNECTED = "Sources e2e, connected"; // the labels of the e2e api's seeded accounts
const DISCONNECTED = "Sources e2e, disconnected";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const messages: Record<string, string> = { ...signals, ...ui };

/** The text of a key with its values; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

/** The words of one case of signals.runs.drops, with its count. */
function dropped(reason: string, count: number): string {
  const words = new RegExp(`[{\\s]${reason} \\{([^{}]*)\\}`).exec(say("signals.runs.drops"))?.[1];
  if (words === undefined) throw new Error(`no case ${reason} in signals.runs.drops`);
  return `${words}: ${count}`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A text anywhere in an element's, as toHaveText takes a part. */
const part = (text: string) => new RegExp(escape(text));

/** When a waiting run resumes in the stubbed usage: Thursday 09:00 in Paris, the accounts' zone. */
const RESUMES_AT = "2026-10-29T08:00:00.000Z";
/** A line with the resume time: the key's words around a time at 09:00, never the server's 08:00. */
const resuming = (key: string, values: Record<string, number> = {}) => {
  const [before, after] = say(key, { ...values, at: "" }).split("<time></time>");
  return new RegExp(`^${escape(before ?? "")}.*09:00.*${escape(after ?? "")}$`);
};

/** A LinkedIn post's URL of its own for each `n` below 100. */
const post = (n: number) =>
  `https://www.linkedin.com/feed/update/urn:li:activity:72500000000000001${String(n).padStart(2, "0")}`;

/** The list's card of the source with the label: an article its heading names. */
const row = (page: Page, label: string) => page.getByRole("article", { name: label, exact: true });
const runNowOf = (page: Page, label: string) =>
  row(page, label).getByRole("button", { name: say("signals.sources.run_now") });

/** Every source of the workspace deleted, with its runs: an earlier test or run may have left some. */
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
  return (await answer.json()) as { id: string };
}

async function seedRuns(request: APIRequestContext, sourceId: string, runs: object[]) {
  const seeded = await request.post(SEED_RUNS, { data: { sourceId, runs } });
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);
}

/** linkedin's usage route answering `usage` for any account, its reads counted by account id. */
async function stubUsage(page: Page, usage: object): Promise<Map<string, number>> {
  const reads = new Map<string, number>();
  await page.route(`**${ACCOUNTS}/*/usage`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return route.fulfill({ json: usage });
  });
  return reads;
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("Run now asks the api once, with a key of its own, and opens the source's runs panel on the new run, scheduled; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const source = await addSource(page, origin, "Run me", await accountId(page, CONNECTED), 1);
  await page.goto(SCREEN);
  const runNow = runNowOf(page, "Run me");
  await expect(runNow).toBeEnabled();
  const posted = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/signals/sources/${source.id}/run`) &&
      response.request().method() === "POST",
  );
  await runNow.click();
  const answer = await posted;
  expect(answer.status()).toBe(202);
  expect(answer.request().headers()["idempotency-key"]).toMatch(UUID);
  const { id, status } = await answer.json();
  expect(status).toBe("scheduled");

  const panel = page.getByRole("region", { name: say("signals.runs.title", { label: "Run me" }) });
  const scheduled = say("signals.runs.status.scheduled");
  await expect(panel.getByRole("rowheader", { name: scheduled })).toHaveCount(1);
  await expect(page).toHaveURL(`${SCREEN}?runs=${source.id}`);
  const { runs } = await (await page.request.get(`${SOURCES}/${source.id}/runs`)).json();
  expect(runs.map((run: { id: string }) => run.id)).toEqual([id]);
  await expect(runNow).toBeEnabled();
  await expectNoSeriousViolation(page);
});

test("after Run now the list is read again, every 15 seconds until its run starts: the card shows the run, Run now disabled and described by its line, and the reads go on while it reads; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const source = await addSource(page, origin, "Start me", await accountId(page, CONNECTED), 14);
  const isList = (sent: Request) => sent.method() === "GET" && sent.url().endsWith(SOURCES);
  const reads: Request[] = [];
  page.on("request", (sent) => {
    if (isList(sent)) reads.push(sent);
  });
  // The page's clock SOURCES_POLL_MS on, 15 seconds, until `check` passes: a jump may come before
  // the screen's newest read has set its next one, and fire one that the newer read drops.
  const pollUntil = (check: () => Promise<void>) =>
    expect(async () => {
      await page.clock.fastForward(15_000);
      await check();
    }).toPass({ timeout: 10_000 });
  await page.clock.install();
  await page.goto(SCREEN);
  const runNow = runNowOf(page, "Start me");
  await expect(runNow).toBeEnabled();
  const reread = page.waitForResponse((response) => isList(response.request()));
  await runNow.click();
  await reread; // Run now's own read of the list, its run scheduled
  await expect(runNow).toBeEnabled();

  // The worker starts the run; the e2e servers run none, so a running run is seeded beside it.
  await seedRuns(request, source.id, [
    { status: "running", startedAt: "2026-10-29T09:00:00.000Z" },
  ]);
  await pollUntil(() => expect(runNow).toBeDisabled({ timeout: 2_000 }));
  await expect(runNow).toHaveAccessibleDescription(say("signals.sources.run_reading"));
  const shown = reads.length;
  await pollUntil(() => expect.poll(() => reads.length, { timeout: 2_000 }).toBeGreaterThan(shown));
  await expectNoSeriousViolation(page);
});

test("a run opened since the list was read makes Run now the api's 409 in words, and Run now is disabled then; a waiting run disables it too", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const sender = await accountId(page, CONNECTED);
  const busy = await addSource(page, origin, "Busy post", sender, 2);
  const waiting = await addSource(page, origin, "Waiting post", sender, 3);
  await seedRuns(request, waiting.id, [
    { status: "waiting", startedAt: "2026-10-26T09:00:00.000Z" },
  ]);
  await page.goto(SCREEN);
  await expect(runNowOf(page, "Waiting post")).toBeDisabled();
  const runNow = runNowOf(page, "Busy post");
  await expect(runNow).toBeEnabled();

  await seedRuns(request, busy.id, [{ status: "running", startedAt: "2026-10-27T09:00:00.000Z" }]);
  const refused = page.waitForResponse((response) => response.url().endsWith(`/${busy.id}/run`));
  await runNow.click();
  expect((await refused).status()).toBe(409);
  const list = page.getByRole("region", { name: say("signals.sources.list_title") });
  await expect(list.getByRole("alert")).toContainText(say("signals.errors.signal_run_open"));
  await expect(runNow).toBeDisabled();
  await expectNoSeriousViolation(page);
});

test("the runs panel shows a run's drops by reason, the end codes of failed runs in words, and a blocked source links to the LinkedIn screen; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const counted = await addSource(
    page,
    origin,
    "Counted post",
    await accountId(page, CONNECTED),
    4,
  );
  await addSource(page, origin, "Blocked post", await accountId(page, DISCONNECTED), 5);
  const at = (day: number, minute = 0) =>
    `2026-10-${String(day).padStart(2, "0")}T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const failed = (day: number, error: string) => ({
    status: "failed",
    startedAt: at(day),
    finishedAt: at(day, 1),
    error,
  });
  const counts = {
    ...{ staged: 40, created: 5, attached: 2, profiles_read: 26 },
    ...{ dropped_known: 4, dropped_company: 3, dropped_own: 1, dropped_filtered: 2 },
    dropped_unread: 1,
  };
  await seedRuns(request, counted.id, [
    { status: "done", startedAt: at(20), finishedAt: at(20, 4), counts },
    failed(21, "insufficient_credits"),
    failed(22, "activity_failed"),
    failed(23, "linkedin_rate_limited"),
    failed(24, "signal_post_not_found"),
  ]);
  await page.goto(`${SCREEN}?runs=${counted.id}`);
  const panel = page.getByRole("region", {
    name: say("signals.runs.title", { label: "Counted post" }),
  });
  const done = panel.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: say("signals.runs.status.done") }),
  });
  await expect(done).toContainText(say("signals.runs.counts", { staged: 40, created: 5 }));
  await expect(done.getByRole("listitem")).toHaveText([
    dropped("dropped_company", 3),
    dropped("dropped_own", 1),
    dropped("dropped_known", 4),
    dropped("dropped_filtered", 2),
    dropped("dropped_unread", 1),
  ]);
  const ended = panel.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: say("signals.runs.status.failed") }),
  });
  await expect(ended).toHaveText([
    part(say("signals.errors.signal_post_not_found")),
    part(say("signals.errors.linkedin_rate_limited")),
    part(say("signals.errors.activity_failed")),
    part(say("signals.errors.insufficient_credits")),
  ]);

  const blocked = row(page, "Blocked post");
  await expect(blocked).toContainText(say("signals.sources.account_disconnected"));
  const link = blocked.getByRole("link", { name: say("signals.sources.blocked") });
  await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/linkedin`);
  await expect(
    row(page, "Counted post").getByRole("link", { name: say("signals.sources.blocked") }),
  ).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("a waiting run's line under Run now: today's LinkedIn reads used, N of N, and when it resumes, in the account's zone; the account not connected, with the link to the LinkedIn screen; Run now looks disabled and is described by its line; the usage read once per account; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const sender = await accountId(page, CONNECTED);
  const capped = await addSource(page, origin, "Capped post", sender, 6);
  const also = await addSource(page, origin, "Capped too", sender, 7);
  const blocked = await addSource(
    page,
    origin,
    "Blocked wait",
    await accountId(page, DISCONNECTED),
    8,
  );
  for (const { id } of [capped, also, blocked]) {
    await seedRuns(request, id, [{ status: "waiting", startedAt: "2026-10-28T09:00:00.000Z" }]);
  }
  const reads = await stubUsage(page, {
    ...{ quotaDay: "2026-10-28", cap: 100, reserved: 4, committed: 96 },
    ...{ windowOpen: true, nextWindowAt: RESUMES_AT },
  });
  await page.goto(SCREEN);
  for (const label of ["Capped post", "Capped too"]) {
    const runNow = runNowOf(page, label);
    await expect(runNow).toBeDisabled();
    const used = resuming("signals.sources.run_waiting_cap", { used: 100, cap: 100 });
    await expect(runNow).toHaveAccessibleDescription(used);
    await expect(row(page, label).locator(`time[datetime="${RESUMES_AT}"]`)).toBeVisible();
  }
  await expect(runNowOf(page, "Capped post")).toHaveCSS("cursor", "not-allowed");
  const waits = `${say("signals.sources.run_waiting_account")} ${say("signals.sources.blocked")}`;
  await expect(runNowOf(page, "Blocked wait")).toHaveAccessibleDescription(waits);
  const links = row(page, "Blocked wait").getByRole("link", {
    name: say("signals.sources.blocked"),
  });
  await expect(links).toHaveCount(2); // the account's warning, and the line's
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", `/w/${WORKSPACE}/linkedin`);
  }
  expect(Object.fromEntries(reads)).toEqual({ [sender]: 1 });
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("a running run's line says it reads now, a waiting run's outside the working hours that it waits for them and when they start; a source with no open run has no line; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const sender = await accountId(page, CONNECTED);
  const reading = await addSource(page, origin, "Reading post", sender, 9);
  const waiting = await addSource(page, origin, "After hours", sender, 10);
  await addSource(page, origin, "Quiet post", sender, 11);
  await seedRuns(request, reading.id, [
    { status: "running", startedAt: "2026-10-28T10:00:00.000Z" },
  ]);
  await seedRuns(request, waiting.id, [
    { status: "waiting", startedAt: "2026-10-28T16:00:00.000Z" },
  ]);
  const reads = await stubUsage(page, {
    ...{ quotaDay: "2026-10-28", cap: 100, reserved: 0, committed: 12 },
    ...{ windowOpen: false, nextWindowAt: RESUMES_AT },
  });
  await page.goto(SCREEN);
  const now = say("signals.sources.run_reading");
  await expect(runNowOf(page, "Reading post")).toHaveAccessibleDescription(now);
  const hours = resuming("signals.sources.run_waiting_hours");
  await expect(runNowOf(page, "After hours")).toHaveAccessibleDescription(hours);
  await expect(row(page, "After hours").locator(`time[datetime="${RESUMES_AT}"]`)).toBeVisible();
  const quiet = runNowOf(page, "Quiet post");
  await expect(quiet).toBeEnabled();
  await expect(quiet).not.toHaveAttribute("aria-describedby");
  await expect(row(page, "Quiet post").locator("p")).toHaveCount(0);
  expect(Object.fromEntries(reads)).toEqual({ [sender]: 1 });
  await expectNoSeriousViolation(page);
});

test("Stop shows beside Run now on a source with an open run only; a press asks the api once, with a key of its own, then reads Stopping…, disabled, once the list is read again and after a reload; axe", async ({
  page,
  request,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const sender = await accountId(page, CONNECTED);
  const open = await addSource(page, origin, "Stop me", sender, 12);
  const later = await addSource(page, origin, "Not started", sender, 13);
  await seedRuns(request, open.id, [{ status: "running", startedAt: "2026-10-28T10:00:00.000Z" }]);
  await seedRuns(request, later.id, [{ status: "scheduled" }]);
  await page.goto(SCREEN);
  const button = (label: string, key: string) =>
    row(page, label).getByRole("button", { name: say(key), exact: true });
  const stop = button("Stop me", "signals.sources.stop");
  await expect(stop).toBeEnabled();
  await expect(stop).toHaveAccessibleDescription(say("signals.sources.run_reading"));
  await expect(button("Not started", "signals.sources.stop")).toHaveCount(0);

  const posted = page.waitForResponse(
    (response) =>
      /\/signals\/sources\/[^/]+\/runs\/[^/]+\/stop$/.test(response.url()) &&
      response.request().method() === "POST",
  );
  const listed = page.waitForResponse(
    (response) => response.url().endsWith(SOURCES) && response.request().method() === "GET",
  );
  await stop.click();
  const answer = await posted;
  expect(answer.status()).toBe(202);
  expect(answer.request().headers()["idempotency-key"]).toMatch(UUID);
  const { runs } = await (await page.request.get(`${SOURCES}/${open.id}/runs`)).json();
  expect(answer.url()).toContain(`/${open.id}/runs/${runs[0].id}/stop`);
  expect((await answer.json()).stopRequestedAt).not.toBeNull();
  await listed;
  const stopping = button("Stop me", "signals.sources.stopping");
  await expect(stopping).toBeDisabled();
  await page.reload();
  await expect(stopping).toBeDisabled();
  await expect(button("Stop me", "signals.sources.stop")).toHaveCount(0);
  await expectNoSeriousViolation(page);
});
