// signals' screen states (alpha-p10-110; core/modules/signals/README.md "Screen") in wsp_e2e_signals,
// this spec's alone (core/apps/api/tests/e2e-signals.ts): the sources screen loading while the api is
// held, failing with a retry, and the retry showing the empty list; the runs panel the same on a
// stubbed source, its error a code of signals' in words; the lead page's evidence panel the same
// inside its slot, on an imported lead of the e2e api's test-only module, then the Imported label and
// the empty text. The api fails through Playwright's routing only; every text from its key, and axe.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Route } from "@playwright/test";
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_signals";
const API = `/api/v1/workspaces/${WORKSPACE}`;
const messages: Record<string, string> = { ...signals, ...platform, ...ui };

/** The text of a key with its values; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

/**
 * The first call to `url` held until `release`, then failed with `status` and `code`; the next ones
 * answered by `next`, the api itself when none is given.
 */
async function holdThenFail(
  page: Page,
  url: string,
  failure = { status: 500, code: "internal_error" },
  next = (route: Route) => route.fallback(),
) {
  const held = Promise.withResolvers<void>();
  let calls = 0;
  await page.route(url, async (route) => {
    calls += 1;
    if (calls > 1) return next(route);
    await held.promise;
    await route.fulfill({ status: failure.status, json: { code: failure.code } });
  });
  return { release: () => held.resolve(), calls: () => calls };
}

/** The region's loading state, announced, with the shared word. */
const expectLoading = (region: Locator) =>
  expect(region.getByRole("status")).toHaveText(say("ui.state.loading"));

/** The region's error state: the shared words, the code's own, and the retry, pressed. */
async function expectFailedThenRetry(region: Locator, words: string): Promise<void> {
  const alert = region.getByRole("alert");
  await expect(alert).toContainText(say("ui.state.error"));
  await expect(alert).toContainText(words);
  await alert.getByRole("button", { name: say("ui.action.retry") }).click();
}

test("the sources screen loads while the api is held, fails with a retry, and the retry shows the empty list; axe", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const sources = await holdThenFail(page, `**${API}/signals/sources`);
  await page.goto(`/w/${WORKSPACE}/sources`);
  await expectLoading(page.getByRole("region", { name: say("signals.sources.loading") }));
  await expectNoSeriousViolation(page);
  sources.release();
  const failed = page.getByRole("region", { name: say("signals.sources.error") });
  await expect(failed.getByRole("alert")).toBeVisible();
  await expectNoSeriousViolation(page);
  await expectFailedThenRetry(failed, say("platform.error.generic"));
  await expect(page.getByText(say("signals.sources.empty"))).toBeVisible();
  expect(sources.calls()).toBe(2);
  await expectNoSeriousViolation(page);
});

test("the runs panel loads while the api is held, fails with the code in words and a retry, and the retry shows its empty state; axe", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  const source = {
    id: "src_01K8E2E0000000000000000001",
    kind: "post_engagers",
    config: { postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000051" },
    label: "Stubbed post",
    senderAccountId: "sac_01K8E2E0000000000000000099",
    enabled: true,
    createdBy: "usr_e2e",
    createdAt: "2026-10-20T09:00:00.000Z",
    lastRunAt: null,
    fireTimes: [],
    nextRunAt: null,
    runOpen: false,
    openRun: null,
  };
  await page.route(`**${API}/signals/sources`, (route) =>
    route.fulfill({ json: { sources: [source] } }),
  );
  const gone = { status: 404, code: "signal_source_not_found" };
  const runs = await holdThenFail(
    page,
    `**${API}/signals/sources/${source.id}/runs`,
    gone,
    (route) => route.fulfill({ json: { runs: [] } }),
  );
  await page.goto(`/w/${WORKSPACE}/sources?runs=${source.id}`);
  const panel = page.getByRole("region", {
    name: say("signals.runs.title", { label: source.label }),
  });
  await expectLoading(panel);
  runs.release();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expectNoSeriousViolation(page);
  await expectFailedThenRetry(panel, say("signals.errors.signal_source_not_found"));
  await expect(panel.getByText(say("signals.runs.empty"))).toBeVisible();
  expect(runs.calls()).toBe(2);
  await expectNoSeriousViolation(page);
});

test("the lead page's evidence panel loads inside its slot while the api is held, fails with a retry, and the retry shows the Imported label and the empty text; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const lead = { slug: "e2e-signals-imported", firstName: "Signals", lastName: "Imported" };
  const answer = await page.request.post(`${API}/e2e/leads`, {
    data: { leads: [{ ...lead, source: "imported" }] },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);
  const [personId] = ((await answer.json()) as { personIds: string[] }).personIds;
  const evidence = await holdThenFail(page, `**${API}/signals/leads/${personId}/evidence`);
  await page.goto(`/w/${WORKSPACE}/leads/${personId}`);
  const panel = page
    .locator('[data-slot="evidence"]')
    .getByRole("region", { name: say("signals.evidence.title") });
  await expectLoading(panel);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Signals Imported");
  evidence.release();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expectNoSeriousViolation(page);
  await expectFailedThenRetry(panel, say("platform.error.generic"));
  await expect(panel.getByText(say("signals.evidence.imported"), { exact: true })).toBeVisible();
  await expect(panel.getByText(say("signals.evidence.empty"))).toBeVisible();
  expect(evidence.calls()).toBe(2);
  await expectNoSeriousViolation(page);
});
