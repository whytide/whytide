// discovery's import screen end to end (alpha-p5-050, alpha-p10-120; core/modules/discovery/README.md
// "The screen"), on the e2e api, which mounts discovery and contacts beside its fixture module, in the
// e2e user's import workspace, and runs no worker. The 50-row file of discovery's route tests goes
// through the file input, reached by keyboard: its report, the run, which the api answers running,
// and the counts once the poll's answer is the api's with what the worker writes (the worker's own
// test, core/apps/worker/tests/discovery-import.test.ts, imports the file). The 46 leads the worker
// writes, their source the job named by its file, are put in by the e2e api's test-only route,
// through contacts' commands, and the run's View leads opens the lead list of the job that counts
// them; axe, and the job in the past imports of a new load, which links to its leads. Then a
// 6 MB file, refused without a request, and a file without linkedin_url. It lives here as
// discovery's route tests live in the api's: a module's test never imports a host.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { cells, figure, file, history, picker, say, WORKSPACE, workerWrites } from "./discovery.ts";
import { expect, test } from "./sign-in.ts";

const FIFTY_ROWS = resolve(
  import.meta.dirname,
  "../../api/tests/fixtures/discovery/fifty-rows.csv",
);

/** The profiles of the file's valid rows, by their slugs: the 46 its run imports. */
function validSlugs(): string[] {
  const lines = readFileSync(FIFTY_ROWS, "utf8").split("\n");
  const slugs = lines.map((line) => /^https:\/\/www\.linkedin\.com\/in\/([a-z0-9-]+),/.exec(line));
  return [...new Set(slugs.flatMap((slug) => (slug?.[1] ? [slug[1]] : [])))];
}

test("the 50-row file by keyboard: 46 valid and four errors by row, the run in the worker and its counts, the job's 46 leads on the lead list, axe, the job in the past imports with its leads", async ({
  page,
  signInAs,
  baseURL,
}) => {
  // Three screens and 46 leads written: past Playwright's 30 seconds on a loaded laptop.
  test.slow();
  await signInAs();
  const slugs = validSlugs();
  expect(slugs).toHaveLength(46);
  await page.goto(`/w/${WORKSPACE}/import`);
  await expect(page).toHaveTitle(say("discovery.import.title"));
  const input = picker(page);
  const focused = () => input.evaluate((element) => element === document.activeElement);
  for (let presses = 0; presses < 30 && !(await focused()); presses++) {
    await page.keyboard.press("Tab");
  }
  await expect(input).toBeFocused();
  await input.setInputFiles(FIFTY_ROWS);

  const fifty = { file: "fifty-rows.csv" };
  await expect(
    page.getByRole("heading", { name: say("discovery.import.report.title", fifty) }),
  ).toBeVisible();
  await expect(figure(page, "discovery.import.report.rows")).toHaveText("50");
  await expect(figure(page, "discovery.import.report.valid")).toHaveText("46");
  await expect(figure(page, "discovery.import.report.errors")).toHaveText("4");
  const report = page.getByRole("table", { name: say("discovery.import.report.table") });
  const lines = report.locator("tbody tr");
  await expect(lines).toHaveCount(4);
  const errors = [
    ["8", "url_invalid"],
    ["20", "url_not_linkedin"],
    ["34", "url_not_linkedin"],
    ["42", "duplicate_in_file"],
  ] as const;
  for (const [index, [row, code]] of errors.entries()) {
    await expect(cells(lines.nth(index))).toHaveText([row, say(`discovery.errors.${code}`)]);
  }

  const run = page.waitForResponse((answer) => answer.url().endsWith("/run"));
  await page.getByRole("button", { name: say("discovery.import.run") }).click();
  const started = await run;
  expect(started.status()).toBe(202);
  const { id } = (await started.json()) as { id: string };
  // The worker's leads, the file's 46 profiles imported and pending qualification, their source the
  // job named by its file, put in through contacts' commands by the e2e api's test-only route.
  const source = { kind: "imported", ref: id, label: "fifty-rows.csv" };
  const seeding = page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads: slugs.map((slug) => ({ slug, source: "imported", sources: [source] })) },
    headers: { origin: baseURL ?? "" },
  });
  await expect(page.getByText(say("discovery.import.running"), { exact: true })).toBeVisible();
  const counts = { created: 46, updated: 0, skippedDuplicate: 1, skippedErased: 0, errors: 3 };
  await workerWrites(page, id, { status: "done", counts, finishedAt: new Date().toISOString() });
  await expect(
    page.getByRole("heading", { name: say("discovery.import.result.title", fifty) }),
  ).toBeVisible();
  await expect(figure(page, "discovery.import.result.created")).toHaveText("46");
  await expect(figure(page, "discovery.import.result.updated")).toHaveText("0");
  await expect(figure(page, "discovery.import.result.skipped_duplicate")).toHaveText("1");
  await expect(figure(page, "discovery.import.result.skipped_erased")).toHaveText("0");
  await expect(figure(page, "discovery.import.result.errors")).toHaveText("3");
  const leads = page.getByRole("link", { name: say("discovery.import.view_leads"), exact: true });
  await expect(leads).toHaveAttribute("href", `/w/${WORKSPACE}/leads?source=${id}`);
  const seeded = await seeding;
  expect(seeded.status(), await seeded.text()).toBe(200);

  // axe (MPL-2.0) is a test-only devDependency of the web, as of the kit.
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  // View leads opens the lead list of the job, which counts its 46 leads, pending qualification.
  await leads.click();
  const pending = say("contacts.leads.status.pending");
  const pills = page.getByRole("list", { name: say("contacts.leads.counts_label") });
  await expect(pills.getByRole("listitem").filter({ hasText: pending })).toHaveText(
    `${pending} 46`,
  );
  // The import screen in a new load, as a reload: goBack() also resolves on the lead list's own
  // replaceState at hydration, and a reload then races the history step.
  await page.goto(`/w/${WORKSPACE}/import`);
  // The newest done job is this one: no worker ends the jobs of the specs that run beside it.
  const done = history(page)
    .locator("tbody tr")
    .filter({
      has: page.getByRole("cell", { name: say("discovery.import.status.done"), exact: true }),
    });
  await expect(cells(done.first())).toHaveText([
    "fifty-rows.csv",
    /\d/, // the upload's date and time
    say("discovery.import.history.you"),
    say("discovery.import.status.done"),
    "50",
    "46",
    "46",
    "0",
    "1",
    "3",
    say("discovery.import.view_leads"),
  ]);
  const view = say("discovery.import.history.view_leads_of", fifty);
  await expect(done.first().getByRole("link", { name: view })).toHaveAttribute(
    "href",
    `/w/${WORKSPACE}/leads?source=${id}`,
  );
});

test("a 6 MB file shows import_too_large without a request; a file without linkedin_url shows import_missing_column", async ({
  page,
  signInAs,
}) => {
  await signInAs();
  await page.goto(`/w/${WORKSPACE}/import`);
  const uploads: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/discovery/imports")) {
      uploads.push(request.url());
    }
  });
  const row = "https://www.linkedin.com/in/example-large,Example Person,Example Company\n";
  const large = `linkedin_url,name,company\n${row.repeat(Math.ceil((6 * 1_048_576) / row.length))}`;
  await picker(page).setInputFiles(file("large.csv", large));
  await expect(
    page.getByText(say("discovery.errors.import_too_large"), { exact: true }),
  ).toBeVisible();
  expect(uploads).toEqual([]);

  await picker(page).setInputFiles(file("no-url.csv", "name,company\nExample Person,Example\n"));
  await expect(
    page.getByText(say("discovery.errors.import_missing_column"), { exact: true }),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
});
