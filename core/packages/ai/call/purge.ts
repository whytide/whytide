// purgeRawRecords (README.md "Decision records"; docs/rules/security.md §6: raw prompts and outputs
// are kept 30 days): nulls raw_prompt and raw_output of every decision record whose raw_purge_after
// has come, in every workspace, through the index on raw_purge_after. A job across workspaces, so it
// takes an `app` client by name, as the outbox claim does (core/packages/db README "The tenant
// transaction and the scoped client", Limits). A daily schedule calls it later; in alpha, a person
// runs `pnpm -F ai purge-raw` (docs/runbook.md).
import { createDbClient, type PrismaClient } from "@whytide/db";

export type PurgeOptions = {
  /** The `app` client, a test's `asRole("app")`; by default one of its own, disconnected after. */
  readonly client?: PrismaClient;
  /** The purge's instant: the records whose raw_purge_after is at or before it lose their raw text. */
  readonly now?: Date;
};

/** Nulls the raw prompt and output of every record past its raw_purge_after; returns how many. */
export async function purgeRawRecords(options: PurgeOptions = {}): Promise<number> {
  const client = options.client ?? createDbClient("app");
  try {
    const { count } = await client.decisionRecord.updateMany({
      where: {
        rawPurgeAfter: { lte: options.now ?? new Date() },
        OR: [{ rawPrompt: { not: null } }, { rawOutput: { not: null } }],
      },
      data: { rawPrompt: null, rawOutput: null },
    });
    return count;
  } finally {
    if (!options.client) await client.$disconnect();
  }
}

if (import.meta.main) {
  const count = await purgeRawRecords();
  process.stdout.write(
    `purge-raw: the raw prompt and output of ${count} decision records nulled\n`,
  );
}
