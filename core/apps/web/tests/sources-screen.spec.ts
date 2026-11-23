// The sources screen end to end (alpha-p8-040; core/modules/signals README.md "Screen"): a post
// source added from the form, listed with its three next fire times; the inline errors of a URL that
// is not a post's and of the eleventh enabled source; the runs panel of factory-seeded runs, its
// card the current one; the warning on a source whose account is not connected; disabling hides the
// fire times, deleting asks first; a topic and the own posts added from the form, a topic's refusals
// under its phrase, each card's target (gamma-p5-020); a competitor's page and a creator added from
// the form, their refusals under their fields, the tracked limit in the form, their cards' links and
// a run LinkedIn found nothing for (gamma-p5-025); a daily source's card, which says it runs daily
// and that its last run stopped at its share of the day's reads (gamma-p5-040); each card's agent,
// linked to the agent's page, or "No agent", in wsp_e2e_source_agents, these two tests' alone, its
// sources the e2e module's and its agent playbooks', linked through playbooks' route on signals'
// checker (gamma-p5-045); another member's source read-only for a Member, her own not, her form
// offering her own account alone and the api refusing another's (gamma-p6-015); every text from its
// key, and axe; a Web research source added from the form with no account field, its refusal under
// its start pages, its card's fields, its cadence and its Edit, and a run that failed for want of a
// country, in words (gamma-wr-030). The sender accounts are the two the e2e api seeds
// (core/apps/api/tests/e2e-signals.ts), never the e2e user's own, which linkedin-connect.spec.ts
// disconnects and connects again; the runs come through the e2e api's test-only route.
import { randomUUID } from "node:crypto";
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
/** The agents' test's workspace, which the e2e api makes and no other test writes to. */
const AGENTS_WORKSPACE = "wsp_e2e_source_agents";
/** A Member of the agents' workspace, made through the e2e module's members route. */
const MEMBER = { email: "e2e-sources-member@example.com", displayName: null, role: "Member" };
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

test("the form adds a topic, its phrase and the roles it keeps, and the own posts; a phrase on a special-category theme and one of 6 words show their errors under the phrase; each card names its kind and shows its target", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  await page.goto(SCREEN);
  const form = page.getByRole("form", { name: say("signals.sources.add_title") });
  const kind = form.getByLabel(say("signals.sources.kind"));
  const label = form.getByLabel(say("signals.sources.label"), { exact: true });
  const add = form.getByRole("button", { name: say("signals.sources.add") });
  await kind.selectOption({ label: say("signals.kinds.topic_engagement.label") });
  await expect(form.getByLabel(say("signals.sources.post_url"))).toHaveCount(0);
  const phrase = form.getByLabel(say("signals.sources.phrase"));
  await phrase.fill("mental health at work");
  await label.fill("RevOps topic");
  await form.getByLabel(say("signals.sources.account")).selectOption({ label: CONNECTED });
  await add.click();
  await expect(form.getByText(say("signals.errors.signal_topic_blocked"))).toBeVisible();
  await expect(phrase).toHaveAttribute("aria-invalid", "true");
  await phrase.fill("one two three four five six");
  await add.click();
  await expect(form.getByText(say("signals.errors.signal_config_invalid"))).toBeVisible();
  // A topic keeps one role at least: the last one checked cannot be unchecked.
  const roles = form.getByRole("group", { name: say("signals.sources.roles") });
  await roles.getByLabel(say("signals.sources.role_reactor")).uncheck();
  await roles.getByLabel(say("signals.sources.role_author")).uncheck();
  await expect(roles.getByLabel(say("signals.sources.role_commenter"))).toBeDisabled();
  await phrase.fill("revenue   operations");
  await add.click();
  const topic = row(page, "RevOps topic");
  await expect(topic).toContainText(say("signals.kinds.topic_engagement.label"));
  await expect(topic).toContainText("revenue operations");

  await kind.selectOption({ label: say("signals.kinds.my_post_engagement.label") });
  await expect(phrase).toHaveCount(0);
  await label.fill("My posts");
  await add.click();
  const own = row(page, "My posts");
  await expect(own).toContainText(say("signals.kinds.my_post_engagement.label"));
  await expect(own).toContainText(say("signals.sources.target_own_posts"));
  const { sources } = await (await page.request.get(SOURCES)).json();
  const stored = sources.map((one: { kind: string; config: unknown }) => [one.kind, one.config]);
  expect(stored).toEqual(
    expect.arrayContaining([
      ["topic_engagement", { phrase: "revenue operations", roles: ["commenter"] }],
      ["my_post_engagement", {}],
    ]),
  );
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("the form adds a competitor's page with its name and a creator; a link of another kind of page and a name off 2 to 100 characters show their errors under their fields; the eleventh tracked source of one account shows signal_tracked_limit; each card links its target; a run that LinkedIn found nothing for says so", async ({
  page,
  signInAs,
  baseURL,
  request,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  await page.goto(SCREEN);
  const form = page.getByRole("form", { name: say("signals.sources.add_title") });
  const kind = form.getByLabel(say("signals.sources.kind"));
  const label = form.getByLabel(say("signals.sources.label"), { exact: true });
  const add = form.getByRole("button", { name: say("signals.sources.add") });
  const invalid = form.getByText(say("signals.errors.signal_config_invalid"));
  await kind.selectOption({ label: say("signals.kinds.competitor_engagement.label") });
  await expect(form.getByLabel(say("signals.sources.post_url"))).toHaveCount(0);
  const companyUrl = form.getByLabel(say("signals.sources.company_url"));
  const companyName = form.getByLabel(say("signals.sources.company_name"));
  await companyUrl.fill("https://www.linkedin.com/in/rival-analytics");
  await companyName.fill("A");
  await label.fill("Rival page");
  await form.getByLabel(say("signals.sources.account")).selectOption({ label: CONNECTED });
  await add.click();
  await expect(invalid).toHaveCount(2);
  await expect(companyUrl).toHaveAttribute("aria-invalid", "true");
  await expect(companyName).toHaveAttribute("aria-invalid", "true");
  await companyUrl.fill("https://linkedin.com/company/rival-analytics/");
  await companyName.fill("Rival Analytics");
  await add.click();
  const rival = row(page, "Rival page");
  await expect(rival).toContainText(say("signals.kinds.competitor_engagement.label"));
  const link = rival.getByRole("link", { name: "Rival Analytics" });
  await expect(link).toHaveAttribute("href", "https://www.linkedin.com/company/rival-analytics");

  await kind.selectOption({ label: say("signals.kinds.creator_engagement.label") });
  await expect(companyUrl).toHaveCount(0);
  const profileUrl = form.getByLabel(say("signals.sources.profile_url"));
  await profileUrl.fill("https://www.linkedin.com/company/rival-analytics");
  await label.fill("Jane's posts");
  await add.click();
  await expect(invalid).toBeVisible();
  await expect(profileUrl).toHaveAttribute("aria-invalid", "true");
  await profileUrl.fill("https://www.linkedin.com/in/jane-doe/");
  await add.click();
  const jane = row(page, "Jane's posts");
  await expect(jane).toContainText(say("signals.kinds.creator_engagement.label"));
  const profile = "https://www.linkedin.com/in/jane-doe";
  await expect(jane.getByRole("link", { name: profile })).toHaveAttribute("href", profile);
  const { sources } = await (await page.request.get(SOURCES)).json();
  const stored = sources.map((one: { kind: string; config: unknown }) => [one.kind, one.config]);
  expect(stored).toEqual([
    ["creator_engagement", { profileUrl: profile }],
    [
      "competitor_engagement",
      {
        companyUrl: "https://www.linkedin.com/company/rival-analytics",
        companyName: "Rival Analytics",
      },
    ],
  ]);

  const senderAccountId = await accountId(page, CONNECTED);
  for (let n = 1; n <= 8; n++) {
    const body = {
      kind: "creator_engagement",
      config: { profileUrl: `https://www.linkedin.com/in/creator-${n}` },
      label: `Creator ${n}`,
      senderAccountId,
    };
    expect((await page.request.post(SOURCES, { data: body, headers: { origin } })).status()).toBe(
      201,
    );
  }
  await page.reload();
  await kind.selectOption({ label: say("signals.kinds.creator_engagement.label") });
  await profileUrl.fill("https://www.linkedin.com/in/creator-9");
  await label.fill("Creator 9");
  await form.getByLabel(say("signals.sources.account")).selectOption({ label: CONNECTED });
  await add.click();
  await expect(form.getByRole("alert")).toContainText(say("signals.errors.signal_tracked_limit"));

  // The list is newest first: the creator's source, then the competitor's.
  const janeId = sources[0].id;
  const failed = {
    status: "failed",
    startedAt: "2026-10-21T09:00:00.000Z",
    finishedAt: "2026-10-21T09:01:00.000Z",
    error: "linkedin_not_found",
  };
  const seeded = await request.post(SEED_RUNS, { data: { sourceId: janeId, runs: [failed] } });
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);
  await page.reload();
  const title = say("signals.runs.title", { label: "Jane's posts" });
  await row(page, "Jane's posts").getByRole("link", { name: title }).click();
  const panel = page.getByRole("region", { name: title });
  await expect(panel).toContainText(say("signals.errors.linkedin_not_found"));
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("a daily source's card says it runs daily, with no fire times, and that its last run stopped at its share of the day's reads, as its runs panel says; every text from its key; axe", async ({
  page,
  signInAs,
  baseURL,
  request,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  const body = {
    kind: "topic_engagement",
    config: { phrase: "pipeline reviews", roles: ["commenter"] },
    label: "Daily topic",
    senderAccountId: await accountId(page, CONNECTED),
  };
  const answer = await page.request.post(SOURCES, { data: body, headers: { origin } });
  expect(answer.status()).toBe(201);
  const topic = await answer.json();
  expect([topic.cadence, topic.lastRunBudgetReached]).toEqual(["daily", false]);
  const reached = {
    status: "done",
    startedAt: "2026-10-29T09:00:00.000Z",
    finishedAt: "2026-10-29T09:03:00.000Z",
    counts: { staged: 30, created: 11, budget_reached: 1 },
  };
  const seeded = await request.post(SEED_RUNS, { data: { sourceId: topic.id, runs: [reached] } });
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);

  await page.goto(SCREEN);
  const card = row(page, "Daily topic");
  await expect(card).toContainText(say("signals.sources.cadence_daily"));
  await expect(card).toContainText(say("signals.runs.budget_reached"));
  await expect(card.locator(`time[datetime="${reached.startedAt}"]`)).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(0);
  const title = say("signals.runs.title", { label: "Daily topic" });
  await card.getByRole("link", { name: title }).click();
  const panel = page.getByRole("region", { name: title });
  const done = panel.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: say("signals.runs.status.done") }),
  });
  await expect(done).toContainText(say("signals.runs.budget_reached"));
  await expect(done).toContainText(say("signals.runs.counts", { staged: 30, created: 11 }));
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("each card names its agent, linked to the agent's page, or says it is in no agent; every text from its key; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const headers = { origin: baseURL ?? "" };
  await signInAs();
  const api = `/api/v1/workspaces/${AGENTS_WORKSPACE}`;
  // No agent and no source; then two sources read through the user's own account.
  const sources = [
    { label: "Agent's post", own: true },
    { label: "Free post", own: true },
  ];
  const seeded = await page.request.post(`${api}/e2e/agents`, { data: { sources }, headers });
  expect(seeded.status()).toBe(200);
  const [linked] = ((await seeded.json()) as { sourceIds: string[] }).sourceIds;
  const { audiences } = await (await page.request.get(`${api}/icp/audiences`)).json();
  const icpId = audiences.find((one: { isDefault: boolean }) => one.isDefault)?.id;
  const created = await page.request.post(`${api}/playbooks`, {
    data: { name: "Revenue agent", icpId },
    headers: { ...headers, "idempotency-key": randomUUID() },
  });
  expect(created.status()).toBe(201);
  const { id: playbookId } = await created.json();
  // Linked through playbooks' route, which asks signals' checker.
  const put = { data: { sourceIds: [linked] }, headers };
  const link = await page.request.put(`${api}/playbooks/${playbookId}/sources`, put);
  expect(link.status(), await link.text()).toBe(200);

  await page.goto(`/w/${AGENTS_WORKSPACE}/sources`);
  const name = say("signals.sources.agent", { name: "Revenue agent" });
  const agent = row(page, "Agent's post").getByRole("link", { name });
  await expect(agent).toHaveAttribute("href", `/w/${AGENTS_WORKSPACE}/agents/${playbookId}`);
  const free = row(page, "Free post");
  await expect(free).toContainText(say("signals.sources.no_agent"));
  await expect(free.getByRole("link", { name })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
  await agent.click();
  await expect(page).toHaveURL(
    (url) => url.pathname === `/w/${AGENTS_WORKSPACE}/agents/${playbookId}`,
  );
});

test("a Member sees another member's source read-only, its switch off and the hint in place of Run now and Delete; her own keeps them; the form offers her own account alone, and the api refuses another's; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  const headers = { origin: baseURL ?? "" };
  const api = `/api/v1/workspaces/${AGENTS_WORKSPACE}`;
  /** The e2e module's agents route: the sources replaced, the signed-in user's account readied. */
  const seed = async (sources: { label: string; own: boolean }[]) => {
    const seeded = await page.request.post(`${api}/e2e/agents`, { data: { sources }, headers });
    expect(seeded.status()).toBe(200);
  };
  /** The signed-in user's own sender account, as linkedin lists it. */
  const ownAccount = async (): Promise<string> => {
    const { accounts } = await (await page.request.get(`${api}/linkedin/accounts`)).json();
    return accounts.find((one: { mine: boolean }) => one.mine).id;
  };
  // The Owner's account and the Member; her source on her own account, the e2e module's; then the
  // Owner's on theirs, through the route.
  await signInAs();
  await seed([]);
  const owners = await ownAccount();
  const members = { members: [MEMBER] };
  expect((await page.request.post(`${api}/e2e/members`, { data: members, headers })).status()).toBe(
    200,
  );
  await signInAs(MEMBER.email);
  await seed([{ label: "Her post", own: true }]);
  const hers = await ownAccount();
  await signInAs();
  const body = { kind: "post_engagers", config: { postUrl: post(90) }, label: "Owner's post" };
  const data = { ...body, senderAccountId: owners };
  expect((await page.request.post(`${api}/signals/sources`, { data, headers })).status()).toBe(201);
  await signInAs(MEMBER.email);
  // Hers may not read through the Owner's account.
  const refused = await page.request.post(`${api}/signals/sources`, { data, headers });
  expect([refused.status(), (await refused.json()).code]).toEqual([403, "forbidden"]);

  await page.goto(`/w/${AGENTS_WORKSPACE}/sources`);
  const switchOf = (label: string) =>
    row(page, label).getByRole("switch", {
      name: say("signals.sources.enabled_switch", { label }),
    });
  const theirs = row(page, "Owner's post");
  await expect(theirs.getByText(say("signals.sources.not_owner"))).toBeVisible();
  await expect(switchOf("Owner's post")).toBeDisabled();
  for (const key of ["signals.sources.run_now", "signals.sources.delete"]) {
    await expect(theirs.getByRole("button", { name: say(key) })).toHaveCount(0);
  }
  const mine = row(page, "Her post");
  await expect(mine.getByText(say("signals.sources.not_owner"))).toHaveCount(0);
  await expect(switchOf("Her post")).toBeEnabled();
  for (const key of ["signals.sources.run_now", "signals.sources.delete"]) {
    await expect(mine.getByRole("button", { name: say(key) })).toBeVisible();
  }
  const form = page.getByRole("form", { name: say("signals.sources.add_title") });
  const account = form.getByLabel(say("signals.sources.account"));
  await expect(account.locator("option")).toHaveCount(1);
  await expect(account).toHaveValue(hers);
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});

test("the form adds a Web research source with no account; a start page on LinkedIn shows its error under its field; its card shows the fields, links the start page and says how often it runs; Edit saves the fields; a run with no country, one with no search and one stopped at its searches' limit say so in words, and the card shows the last plan's words and source types; axe", async ({
  page,
  signInAs,
  baseURL,
  request,
}) => {
  const origin = baseURL ?? "";
  await signInAs();
  await reset(page, origin);
  await page.goto(SCREEN);

  const form = page.getByRole("form", { name: say("signals.sources.add_title") });
  await form
    .getByLabel(say("signals.sources.kind"))
    .selectOption({ label: say("signals.kinds.web_research.label") });
  await expect(form.getByLabel(say("signals.sources.account"))).toHaveCount(0);
  const pages = form.getByLabel(say("signals.sources.start_pages"));
  await form.getByLabel(say("signals.sources.focus")).fill("makers of paper cups");
  await form.getByLabel(say("signals.sources.region")).fill("the northern coast");
  await form.getByRole("combobox", { name: say("signals.sources.languages") }).click();
  await page.getByRole("option", { name: "Spanish", exact: true }).click();
  await form.getByLabel(say("signals.sources.label"), { exact: true }).fill("Cups research");
  await pages.fill("https://www.linkedin.com/company/example-cups");
  const add = form.getByRole("button", { name: say("signals.sources.add") });
  await add.click();
  await expect(form.getByText(say("signals.errors.signal_config_invalid"))).toBeVisible();
  await expect(pages).toHaveAttribute("aria-invalid", "true");

  await pages.fill("https://directory.example/members");
  await add.click();
  const card = row(page, "Cups research");
  await expect(card).toContainText("makers of paper cups");
  await expect(card).toContainText("the northern coast");
  await expect(card).toContainText("Spanish");
  await expect(card).toContainText("7 days");
  await expect(card).not.toContainText(say("signals.sources.account_unknown"));
  await expect(card).not.toContainText(say("signals.sources.account_disconnected"));
  const link = card.getByRole("link", { name: "https://directory.example/members" });
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const [source] = (await (await page.request.get(SOURCES)).json()).sources;
  expect([source.kind, source.senderAccountId, source.cadence, source.everyDays]).toEqual([
    "web_research",
    null,
    "research",
    7,
  ]);

  await card
    .getByRole("button", { name: say("signals.sources.edit_of", { label: "Cups research" }) })
    .click();
  const dialog = page.getByRole("dialog", {
    name: say("signals.sources.edit_title", { label: "Cups research" }),
  });
  await dialog.getByLabel(say("signals.sources.focus")).fill("makers of glass jars");
  await dialog.getByRole("button", { name: say("signals.sources.save") }).click();
  await expect(card).toContainText("makers of glass jars");
  await expect(card).not.toContainText("makers of paper cups");

  await expect(card).toContainText(say("signals.sources.plan_none"));

  const failed = {
    status: "failed",
    startedAt: "2026-10-21T09:00:00.000Z",
    finishedAt: "2026-10-21T09:00:01.000Z",
    error: "research_no_country",
  };
  const stopped = {
    status: "done",
    startedAt: "2026-10-22T09:00:00.000Z",
    finishedAt: "2026-10-22T09:00:09.000Z",
    counts: { queries_planned: 3, searches_asked: 2, search_results: 17, budget_reached: 1 },
    plan: {
      words: [
        { language: "es", words: ["vasos de papel", "envases"] },
        { language: "fr", words: ["gobelets"] },
      ],
      placeIds: ["web_search", "fair_exhibitors"],
    },
  };
  const unavailable = {
    status: "failed",
    startedAt: "2026-10-23T09:00:00.000Z",
    finishedAt: "2026-10-23T09:00:01.000Z",
    error: "research_search_unavailable",
  };
  const runs = [failed, stopped, unavailable];
  const seeded = await request.post(SEED_RUNS, { data: { sourceId: source.id, runs } });
  expect(seeded.status(), "the api on API_PORT must be serve:e2e").toBe(204);
  await page.goto(`${SCREEN}?runs=${source.id}`);
  const panel = page.getByRole("region", {
    name: say("signals.runs.title", { label: "Cups research" }),
  });
  await expect(panel).toContainText(say("signals.errors.research_no_country"));
  await expect(panel).toContainText(say("signals.errors.research_search_unavailable"));
  await expect(panel).toContainText(say("signals.runs.research_budget_reached"));
  await expect(panel).toContainText(
    say("signals.runs.research_counts", { planned: 3, asked: 2, results: 17 }),
  );
  const plan = row(page, "Cups research");
  await expect(plan).toContainText("vasos de papel, envases");
  await expect(plan).toContainText("gobelets");
  await expect(plan).toContainText(say("signals.places.web_search.label"));
  await expect(plan).toContainText(say("signals.places.fair_exhibitors.label"));
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);
});
