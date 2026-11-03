// `pnpm db:migrate:dev [--name <module>_<change>] [prisma options]`: a migration from the schema, for
// the person at a terminal. The name is checked here, or asked for, before Prisma runs; everything
// else is `prisma migrate dev` as the owner, with the shadow database Prisma creates itself.
import { createInterface } from "node:readline/promises";
import { databaseUrl } from "./env.ts";
import { migrationNameProblem } from "./migration-names.ts";
import { prisma } from "./prisma-cli.ts";

const USAGE = "usage: pnpm db:migrate:dev --name <module>_<change> [--create-only]";

/** Returns the exit code. */
export async function migrateDev(args: readonly string[]): Promise<number> {
  let name: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--name" || arg === "-n") name = args[++i] ?? "";
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
    else rest.push(arg);
  }
  if (name === undefined) {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    name = await ask("Migration name (<module>_<change>): ");
  }
  const problem = migrationNameProblem(name);
  if (problem) {
    process.stderr.write(`${problem}\n${USAGE}\n`);
    return 1;
  }
  const run = await prisma(["migrate", "dev", "--name", name, ...rest], {
    url: databaseUrl("owner"),
    stdio: "inherit",
  });
  return run.code ?? 1;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
