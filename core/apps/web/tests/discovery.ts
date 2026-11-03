// The helpers of discovery's import screen specs (import-screen.spec.ts, discovery-states.spec.ts)
// in the e2e api's import workspace: a key's text, the file picker, a count, a row's cells, and the
// stub of what the e2e api lacks, a worker: its writes to a job it runs.
import type { Locator, Page } from "@playwright/test";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import discovery from "../../../modules/discovery/messages/en.json" with { type: "json" };
import platform from "../../../packages/platform/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };

// The e2e api's IMPORT_WORKSPACE: the files port takes a workspace id of letters and digits only.
export const WORKSPACE = "wsp_e2eimport";
/** The list's address; a job's, never a run's. */
export const LIST = "**/api/v1/workspaces/*/discovery/imports";
const JOB = "**/api/v1/workspaces/*/discovery/imports/*";
const messages: Record<string, string> = { ...platform, ...ui, ...discovery, ...contacts };

/** The text of a key with its values put in; a key missing from the messages fails the test. */
export function say(key: string, values: Record<string, string | number> = {}): string {
  const message = messages[key];
  if (message === undefined) throw new Error(`no message ${key}`);
  return message.replace(/\{(\w+)(?:, number)?\}/g, (_, name: string) => String(values[name]));
}

export const picker = (page: Page) =>
  page.getByLabel(say("discovery.import.pick"), { exact: true });
/** A count of the report or of the run: the definition after the term that names it. */
export const figure = (page: Page, key: string) =>
  page
    .getByRole("term")
    .filter({ hasText: new RegExp(`^${say(key)}$`) })
    .locator("xpath=following-sibling::dd[1]");
export const cells = (row: Locator) => row.locator("th, td");
export const history = (page: Page) =>
  page.getByRole("table", { name: say("discovery.import.history.title") });
export const file = (name: string, content: string | Buffer, mimeType = "text/csv") => ({
  name,
  mimeType,
  buffer: Buffer.from(content),
});

/**
 * The screen's next reads of job `id`, itself or in the past imports, answer the api's job with
 * `change`, as the worker leaves it.
 */
export async function workerWrites(page: Page, id: string, change: Record<string, unknown>) {
  const patch = (job: { id: string }) => (job.id === id ? { ...job, ...change } : job);
  await page.route(JOB, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: patch(await response.json()) });
  });
  await page.route(LIST, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const { jobs } = (await response.json()) as { jobs: { id: string }[] };
    await route.fulfill({ response, json: { jobs: jobs.map(patch) } });
  });
}
