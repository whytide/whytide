// The agents (README "Agents"): at start, the task registry from the modules' sources, every task's
// model priced, and the worker's one Mastra instance, passive (Temporal owns the durable part). It
// is made under a Postgres advisory lock: Mastra creates its tables with CREATE TABLE IF NOT EXISTS,
// which two workers starting together on a fresh database would race into a unique violation.
// Activities call callAgent from @whytide/ai, outside any tenant run.
import { checkAgentPrices, createMastra, loadAgentTasks, type MastraInstance } from "@whytide/ai";
import type { PrismaClient } from "@whytide/db";
import { getAdapter, llmConfig, llmPort } from "@whytide/providers";

export async function startAgents(client: PrismaClient): Promise<MastraInstance> {
  await loadAgentTasks();
  await checkAgentPrices();
  const llm = await getAdapter(llmPort, llmConfig.PROVIDER_LLM);
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('whytide.mastra_init'))`;
      return createMastra({ llm });
    },
    { timeout: 60_000 },
  );
}
