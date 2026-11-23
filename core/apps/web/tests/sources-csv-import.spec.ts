// The import of a CSV file of sources end to end (sources-csv-import; core/modules/signals/README.md
// "Importing sources"), on the e2e api in its source-imports workspace, this spec's alone
// (core/apps/api/tests/e2e-server.ts): a file not CSV refused in words; a file of valid rows and rows
// with an error checked, its figures and both tables, the errors' download; the valid rows imported,
// the result's figures; the new sources' cards naming the file, and the Imported files' card of the
// import; axe on the check and on the result, and the screen at a phone's width, light only.
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import signals from "../../../modules/signals/messages/en.json" with { type: "json" };
import { file } from "./discovery.ts";
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_source_imports";
const SOURCES = `/api/v1/workspaces/${WORKSPACE}/signals/sources`;
const FILE = "sources-e2e.csv";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000081";
const CREATOR = "https://www.linkedin.com/in/e2e-csv-creator";
/** Three rows to import (2, 3, 6) and three with an error (4, 5, 7). */
const CONTENT = [
  "kind,url,name,phrase,roles,label",
  `post,${POST},,,,CSV post e2e`,
  `creator,${CREATOR},,,,`,
  "planet,https://example.com/planet,,,,",
  "company,https://www.linkedin.com/company/e2e-csv-competitor,,,,",
  "topic,,,revenue operations,author;commenter,",
  `post,${POST},,,,Again`,
].join("\n");
const messages: Record<string, string> = signals;

/** The text of a key with its values; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

/** A count of a part: the definition after the term that names it. */
const figure = (part: Locator, key: string) =>
  part
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${say(key)}$`) })
    .locator("xpath=following-sibling::dd[1]");

/** Every source of the workspace deleted through the api: an earlier run may have left some. */
async function reset(page: Page, origin: string): Promise<void> {
  const { sources } = await (await page.request.get(SOURCES)).json();
  for (const { id } of sources) {
    expect(await page.request.delete(`${SOURCES}/${id}`, { headers: { origin } })).toBeOK();
  }
}

async function expectNoSeriousViolation(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
}

test("a CSV file of sources checked, its errors listed, its valid rows imported: the cards name the file, Imported files lists the import; axe; a phone's width", async ({
  page,
  signInAs,
  baseURL,
}) => {
  test.slow();
  await signInAs();
  await reset(page, baseURL ?? "");
  await page.goto(`/w/${WORKSPACE}/sources`);
  await page.getByRole("button", { name: say("signals.sources.import_csv"), exact: true }).click();
  const panel = page.getByRole("region", { name: say("signals.source_imports.title") });
  const picker = panel.getByLabel(say("signals.source_imports.file"), { exact: true });

  await picker.setInputFiles(file("notes.txt", CONTENT, "text/plain"));
  await expect(
    panel.getByText(say("signals.errors.signal_import_unsupported_type"), { exact: true }),
  ).toBeVisible();

  await picker.setInputFiles(file(FILE, CONTENT));
  const check = panel.getByRole("region", {
    name: say("signals.source_imports.check_title", { file: FILE }),
  });
  await expect(check).toBeVisible();
  await expect(figure(check, "signals.source_imports.rows")).toHaveText("6");
  await expect(figure(check, "signals.source_imports.valid")).toHaveText("3");
  await expect(figure(check, "signals.source_imports.with_errors")).toHaveText("3");
  const valid = check.getByRole("table", { name: say("signals.source_imports.valid_table") });
  await expect(valid.locator("tbody tr")).toHaveText([
    /^2.*CSV post e2e$/,
    /^3.*linkedin\.com\/in\/e2e-csv-creator$/,
    /^6.*revenue operations$/,
  ]);
  const errors = check.getByRole("table", { name: say("signals.source_imports.errors_table") });
  await expect(errors.locator("tbody tr")).toHaveText([
    `4kind${say("signals.source_imports.problems.signal_kind_unknown")}`,
    `5name${say("signals.source_imports.problems.signal_config_invalid")}`,
    `7${say("signals.source_imports.problems.duplicate_in_file")}`,
  ]);
  const download = check.getByRole("link", { name: say("signals.source_imports.download_errors") });
  await expect(download).toHaveAttribute("download", "sources-e2e-errors.csv");
  await expect(page.getByRole("main")).not.toContainText("signals.");
  await expectNoSeriousViolation(page);

  await check.getByRole("button", { name: say("signals.source_imports.run") }).click();
  const result = panel.getByRole("region", {
    name: say("signals.source_imports.result_title", { file: FILE }),
  });
  await expect(result).toBeVisible();
  await expect(figure(result, "signals.source_imports.created")).toHaveText("3");
  await expect(figure(result, "signals.source_imports.disabled")).toHaveText("0");
  await expect(figure(result, "signals.source_imports.refused")).toHaveText("3");

  const from = say("signals.sources.imported_from", { file: FILE });
  for (const label of ["CSV post e2e", "linkedin.com/in/e2e-csv-creator", "revenue operations"]) {
    await expect(page.getByRole("article", { name: label, exact: true })).toContainText(from);
  }
  const imports = page.getByRole("region", { name: say("signals.imports.title") });
  const card = imports.getByRole("article", { name: FILE, exact: true }).first();
  await expect(card).toContainText(say("signals.imports.sources_kind"));
  await expect(figure(card, "signals.imports.created")).toHaveText("3");
  await expect(figure(card, "signals.imports.refused")).toHaveText("3");
  await expect(figure(card, "signals.imports.disabled")).toHaveCount(0);
  await expect(card.getByRole("link")).toHaveCount(0);
  await expectNoSeriousViolation(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForLoadState("networkidle");
  const wide = await page.evaluate(() => {
    const root = document.documentElement;
    const boxes: string[] = root.scrollWidth > root.clientWidth ? ["document"] : [];
    for (let box = document.querySelector("main"); box; box = box.parentElement) {
      if (box.scrollWidth > box.clientWidth) boxes.push(`${box.tagName} ${box.scrollWidth}`);
    }
    return boxes;
  });
  expect(wide).toEqual([]);
});
