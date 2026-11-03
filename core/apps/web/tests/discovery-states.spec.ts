// The import screen's states and downloads end to end (alpha-p10-120; core/modules/discovery/README.md
// "The screen"), on the e2e api's import workspace, which runs no worker: the past imports loading,
// empty and failed, with a retry, and axe on each before any upload; the sample, which validates
// clean, and the report's error rows, row numbers and codes; the file codes in words, without a
// retry, and an upload the api fails, with one; a run the api fails, which stays validated, then a
// cut answer to its retry, after which the job says how the run went: running for eleven minutes, so
// the screen says it may be stuck and stops reading it. The stubs answer as the api or the worker.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  cells,
  figure,
  file,
  history,
  LIST,
  picker,
  say,
  WORKSPACE,
  workerWrites,
} from "./discovery.ts";
import { expect, test } from "./sign-in.ts";

const RUN = "**/api/v1/workspaces/*/discovery/imports/*/run";
const FIFTY_ROWS = resolve(
  import.meta.dirname,
  "../../api/tests/fixtures/discovery/fifty-rows.csv",
);
const failed = { status: 500, json: { code: "internal_error" } };
const past = (page: Page) =>
  page.getByRole("region", { name: say("discovery.import.history.title") });
const alert = (page: Page) => page.locator(".discovery-import").getByRole("alert");
const retry = (page: Page) => page.getByRole("button", { name: say("ui.action.retry") });

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

/** Saves what the link downloads: its suggested name and its text. */
async function download(page: Page, name: string) {
  const saved = page.waitForEvent("download");
  await page.getByRole("link", { name }).click();
  const done = await saved;
  return { name: done.suggestedFilename(), text: readFileSync(await done.path(), "utf8") };
}

test("before any upload: the past imports loading, then empty, from keys; axe passes on both", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route(LIST, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    await route.fulfill({ json: { jobs: [] } });
  });
  await page.goto(`/w/${WORKSPACE}/import`);
  await expect(past(page).getByRole("status")).toHaveText(say("discovery.import.loading"));
  await axe(page);
  answer();
  await expect(past(page).getByText(say("discovery.import.empty"), { exact: true })).toBeVisible();
  await axe(page);
});

test("the past imports failed: the code in words and a retry that reads them again; axe passes; another user's job names no uploader", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({ json: { user: { id: "usr_someone_else" }, memberships: [] } }),
  );
  await page.route(LIST, (route) => route.fulfill(failed), { times: 1 });
  await page.goto(`/w/${WORKSPACE}/import`);
  await expect(past(page).getByText(say("discovery.import.error"), { exact: true })).toBeVisible();
  await expect(past(page).getByRole("alert")).toContainText(say("ui.state.error"));
  await expect(past(page).getByRole("alert")).toContainText(say("platform.error.generic"));
  await axe(page);
  await picker(page).setInputFiles(file("states.csv", readFileSync(FIFTY_ROWS)));
  await expect(figure(page, "discovery.import.report.valid")).toHaveText("46");
  await past(page)
    .getByRole("button", { name: say("ui.action.retry") })
    .click();
  // The newest states.csv: another spec may upload to the workspace meanwhile.
  const row = history(page).locator("tbody tr").filter({ hasText: "states.csv" }).first();
  await expect(cells(row).nth(0)).toHaveText("states.csv");
  await expect(cells(row).nth(2)).toHaveText("");
});

test("the sample downloads and validates clean; the report's error rows download as row numbers and codes", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/import`);
  const sample = await download(page, say("discovery.import.sample"));
  expect(sample.name).toBe("import-sample.csv");
  await picker(page).setInputFiles(file(sample.name, sample.text));
  await expect(figure(page, "discovery.import.report.rows")).toHaveText("3");
  await expect(figure(page, "discovery.import.report.valid")).toHaveText("3");
  await expect(figure(page, "discovery.import.report.errors")).toHaveText("0");
  await expect(
    page.getByRole("link", { name: say("discovery.import.download_errors") }),
  ).toHaveCount(0);

  await picker(page).setInputFiles(FIFTY_ROWS);
  await expect(figure(page, "discovery.import.report.errors")).toHaveText("4");
  const rows = await download(page, say("discovery.import.download_errors"));
  expect(rows).toEqual({
    name: "fifty-rows-errors.csv",
    text: "row,code\n8,url_invalid\n20,url_not_linkedin\n34,url_not_linkedin\n42,duplicate_in_file\n",
  });
});

test("the file codes in words without a retry; an upload the api fails offers one, which sends the file again", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/import`);
  const refused = [
    ["import_too_many_rows", file("many.csv", `linkedin_url\n${"x\n".repeat(50_001)}`)],
    ["import_unsupported_type", file("people.xlsx", "linkedin_url\n", "application/octet-stream")],
    [
      "import_bad_encoding",
      file("latin1.csv", Buffer.from("linkedin_url,name\nexample,Renée\n", "latin1")),
    ],
  ] as const;
  for (const [code, refusedFile] of refused) {
    await picker(page).setInputFiles(refusedFile);
    await expect(alert(page)).toContainText(say(`discovery.errors.${code}`));
    await expect(retry(page)).toHaveCount(0);
  }

  await page.route(LIST, (route) => route.fulfill(failed), { times: 1 });
  await picker(page).setInputFiles(FIFTY_ROWS);
  await expect(alert(page)).toContainText(say("platform.error.generic"));
  await retry(page).click();
  await expect(figure(page, "discovery.import.report.valid")).toHaveText("46");
});

test("a run the api fails stays validated, with a retry; a cut answer to it, and the job running for eleven minutes: it may be stuck, uploaded by you, and no longer read", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/import`);
  const uploaded = page.waitForResponse(
    (answer) => answer.request().method() === "POST" && answer.url().endsWith("/discovery/imports"),
  );
  await picker(page).setInputFiles(file("stuck.csv", readFileSync(FIFTY_ROWS)));
  const { id } = (await (await uploaded).json()) as { id: string };
  await expect(figure(page, "discovery.import.report.valid")).toHaveText("46");

  // A failure before the claim: the job is still validated, and the run can be pressed again.
  await page.route(RUN, (route) => route.fulfill(failed), { times: 1 });
  await page.getByRole("button", { name: say("discovery.import.run") }).click();
  await expect(alert(page)).toContainText(say("platform.error.generic"));
  await expect(page.getByRole("button", { name: say("discovery.import.run") })).toBeVisible();

  // The retry's answer is cut after the api claimed the job; the worker started it 11 minutes ago.
  await page.route(
    RUN,
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  await workerWrites(page, id, { startedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
  let reads = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && /\/discovery\/imports\/[^/]+$/.test(path)) reads += 1;
  });
  await retry(page).click();
  // The hint under the run, and in the job's row, first in the past imports; earlier runs' jobs,
  // which no worker ended, may show it too.
  const stuck = say("discovery.import.stuck");
  await expect(page.locator("p").filter({ hasText: stuck })).toHaveCount(1);
  await expect(alert(page)).toHaveCount(0);
  const first = cells(history(page).locator("tbody tr").first());
  await expect(first.nth(2)).toHaveText(say("discovery.import.history.you"));
  await expect(first.nth(3)).toContainText(say("discovery.import.status.running"));
  await expect(first.nth(3)).toContainText(stuck);
  const after = reads;
  await page.waitForTimeout(5_000); // two and a half polls: none comes
  expect(reads).toBe(after);
});
