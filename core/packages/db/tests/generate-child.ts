// The stand-in for Prisma of tests/generate.test.ts, and one generate in a process of its own:
//   node tests/generate-child.ts <root>
// The stand-in does to generated/ what Prisma 7's generate does: it removes the client, waits, then
// writes it again. Each run adds a line to <root>/prisma-runs.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { generate } from "../src/generate.ts";

export const fakePrisma = (root: string) => async () => {
  appendFileSync(join(root, "prisma-runs"), `${process.pid}\n`);
  rmSync(join(root, "generated", "client.ts"), { force: true });
  await sleep(200);
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(join(root, "generated", "client.ts"), "export {};\n");
  return 0;
};

/** How many times the stand-in ran on the root, once at least. */
export const prismaRuns = (root: string) =>
  readFileSync(join(root, "prisma-runs"), "utf8").trim().split("\n").length;

if (import.meta.main) {
  const [root = ""] = process.argv.slice(2);
  process.exitCode = await generate([], { root, prisma: fakePrisma(root) });
}
