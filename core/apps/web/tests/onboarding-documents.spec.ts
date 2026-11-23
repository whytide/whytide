// onboarding's documents' card on the Company screen end to end (onboarding-setup; core/modules/
// onboarding/README.md "The documents"), on the e2e api: a Markdown and a text file read in the
// browser with no PDF.js loaded, then a PDF read through unpdf, its chunk loaded then; a scan and a
// Word file refused in words; Draft from documents sends the texts read, and the e2e api, which runs
// no worker, drafts the run from them (e2e-onboarding.ts in core/apps/api/tests): the review shows
// each value's document. axe passes. The tests share the workspace's record, so they run in this
// file only, one after the other.
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import onboarding from "../../../modules/onboarding/messages/en.json" with { type: "json" };
import ui from "../../../packages/ui/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const D = "wsp_e2e_documents"; // the documents' card's own workspace: no other spec writes its record
const SEED = `http://127.0.0.1:${process.env.API_PORT}/test/onboarding/documents`;
const FILES = join(import.meta.dirname, "..", "..", "..", "modules", "onboarding", "tests");
const fixture = (name: string) => join(FILES, "fixtures", "documents", name);
const messages: Record<string, string> = { ...onboarding, ...ui };

/** The text of a key, its `{…}` arguments filled; a key missing from the messages fails the test. */
function say(key: string, values: Record<string, string | number> = {}): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

const card = (page: Page) => page.locator('[data-part="documents"]');
const row = (page: Page, name: string) => card(page).locator(`[data-document="${name}"]`);

test("a Markdown and a text file read with no PDF.js, then a PDF through unpdf; a scan and a Word file refused, one removed; Draft from documents sends the texts and the review shows their documents; axe passes", async ({
  page,
  request,
  signInAs,
}) => {
  expect((await request.post(`${SEED}/empty`)).status(), "the api must be serve:e2e").toBe(204);
  await signInAs();
  // Each script the page loads, and whether it is PDF.js's.
  const scripts: boolean[] = [];
  page.on("response", async (response) => {
    if (response.request().resourceType() !== "script") return;
    scripts.push((await response.text().catch(() => "")).includes("WorkerMessageHandler"));
  });
  await page.goto(`/w/${D}/company`);
  await expect(
    page.getByRole("heading", { name: say("onboarding.company.documents.title") }),
  ).toBeVisible();
  const draft = page.getByRole("button", { name: say("onboarding.company.documents.draft") });
  await expect(draft).toBeDisabled();
  const input = page.getByLabel(say("onboarding.company.documents.pick"));
  await input.setInputFiles([fixture("faq.md"), fixture("notes.txt")]);
  const read = say("onboarding.company.documents.read");
  await expect(row(page, "faq.md")).toContainText(read);
  await expect(row(page, "notes.txt")).toContainText(read);
  expect(scripts.some(Boolean), "no PDF.js before a PDF is picked").toBe(false);

  const word = { name: "deck.docx", mimeType: "application/msword", buffer: Buffer.from("PK") };
  await input.setInputFiles([fixture("deck.pdf"), fixture("scan.pdf")]);
  await input.setInputFiles([word]);
  await expect(row(page, "deck.pdf")).toContainText(read);
  await expect(row(page, "scan.pdf")).toContainText(say("onboarding.errors.document_no_text"));
  await expect(row(page, "deck.docx")).toContainText(
    say("onboarding.errors.document_type_unsupported"),
  );
  expect(scripts.some(Boolean), "PDF.js loaded once a PDF is picked").toBe(true);
  await card(page)
    .getByRole("button", { name: say("ui.list.remove", { item: "scan.pdf" }) })
    .click();
  await expect(row(page, "scan.pdf")).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page })
    .include('[data-part="documents"]')
    .analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);

  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().endsWith("/company-knowledge/draft"),
  );
  await draft.click();
  const body = (await sent).postDataJSON() as { documents: Record<string, string>[] };
  expect(body.documents.map(({ name, mediaType, status }) => [name, mediaType, status])).toEqual([
    ["faq.md", "text/markdown", "read"],
    ["notes.txt", "text/plain", "read"],
    ["deck.pdf", "application/pdf", "read"],
  ]);
  expect(body.documents[2]?.text).toBe(
    "Corvid Freight\nSame-day parcels for small shops.\nTrusted by 300 shops in the city.",
  );
  await expect(page.getByText(say("onboarding.company.fetching"))).toBeVisible();

  // The worker's run, as the e2e api writes it: the screen asks again within two seconds.
  expect((await request.post(`${SEED}/drafted`)).status()).toBe(204);
  const review = page.locator('[data-part="draft-review"]');
  await expect(review).toBeVisible({ timeout: 10_000 });
  await expect(review.locator('[data-review-field="products"]')).toContainText("Same-day parcels");
  await expect(
    review.getByText(say("onboarding.company.source.document", { name: "deck.pdf" })).first(),
  ).toBeVisible();
});
