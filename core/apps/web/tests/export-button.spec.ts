// contacts' Export button on the lead list (alpha-p9-050; core/modules/contacts/README.md "Screens"),
// on leads that the e2e api's test-only module writes (core/apps/api/tests/fixtures/e2e) in the e2e
// users' export workspace, whose leads are this spec's alone: with the tier filter at Hot, Export
// downloads the CSV of the hot qualified leads only, UTF-8 with a byte-order mark and a formula
// neutralized; axe.
import { readFile } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import contacts from "../../../modules/contacts/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_e2e_export";
const messages: Record<string, string> = contacts;

/** The text of a key; a key missing from the messages fails the test. */
function say(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`no message ${key}`);
  return value;
}

const lead = (slug: string, fitScore: number, tier: string, companyName = "Blue Harbor Labs") => ({
  slug: `e2e-export-${slug}`,
  firstName: "Export",
  lastName: slug,
  title: "Head of Data",
  companyName,
  source: "imported",
  decision: { status: "qualified", fitScore, confidence: "high", tier },
});

test("with the tier filter at Hot, Export downloads the CSV of the hot qualified leads only, with a byte-order mark and a formula neutralized; axe", async ({
  page,
  signInAs,
  baseURL,
}) => {
  await signInAs();
  const leads = [
    lead("first", 90, "hot", "=SUM(A1)"),
    lead("second", 80, "hot"),
    lead("third", 65, "warm"),
  ];
  const answer = await page.request.post(`/api/v1/workspaces/${WORKSPACE}/e2e/leads`, {
    data: { leads },
    headers: { origin: baseURL ?? "" },
  });
  expect(answer.status(), await answer.text()).toBe(200);

  await page.goto(`/w/${WORKSPACE}/leads`);
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  // React replays a change made before hydration; the list's answer shows it hydrated.
  await page.getByLabel(say("contacts.leads.filter.tier"), { exact: true }).selectOption("hot");
  await expect(rows).toHaveCount(2);
  await expect(page.locator("[aria-busy]")).toHaveCount(0);

  const asked = page.waitForRequest((request) => request.url().includes("/exports/leads.csv"));
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: say("contacts.leads.export") }).click();
  const query = new URL((await asked).url()).searchParams;
  expect(Object.fromEntries(query)).toEqual({ status: "qualified", tier: "hot" });
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile(await download.path(), "utf8");
  expect(text.startsWith("﻿first_name,last_name,")).toBe(true);
  const lines = text.trimEnd().split("\r\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain("Export,first,,Head of Data,'=SUM(A1),,90,hot,high,qualified");
  expect(lines[2]).toContain("Export,second,");
  expect(text).not.toContain("third");

  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
});
