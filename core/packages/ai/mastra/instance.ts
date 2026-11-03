// The Mastra instance (README.md "The Mastra instance"; docs/architecture.md §8): one per worker,
// made at start after loadAgentTasks(), the registry's tasks as its agents and its storage
// @mastra/pg in a schema of its own on the product database. Once it is made, runAgent runs its
// agents. A call's model comes in the call's request context: getModel binds the usage callback to
// the model it returns, so the instance holds no model shared across calls.
import "../run/guard.ts";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { RequestContext } from "@mastra/core/request-context";
import { MastraCompositeStore } from "@mastra/core/storage";
import { PostgresStore } from "@mastra/pg";
import { databaseUrl } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { getAdapter, llmConfig, llmPort, type PortInstance } from "@whytide/providers";
import { aiErrors } from "../errors.ts";
import { type AgentTask, registeredAgentTasks } from "../registry/define.ts";
import { mastraConfig } from "./config.ts";

type Llm = PortInstance<typeof llmPort>;
type Model = Awaited<ReturnType<Llm["getModel"]>>["model"];
/** What a host gets: shutdown() only. Its agents run through runAgent and callAgent, never the raw Mastra. */
export type MastraInstance = { shutdown(): Promise<void> };

const MODEL = "whytide.model";
let current: { readonly mastra: Mastra; readonly llm: Llm } | undefined;
const raw = new WeakMap<MastraInstance, Mastra>();

/** The raw Mastra of an instance, for this package's tests: its agents skip runAgent and callAgent. */
export function mastraOf(instance: MastraInstance): Mastra {
  const mastra = raw.get(instance);
  if (!mastra) throw new Error("not an instance createMastra made");
  return mastra;
}

const noLogs = async () => ({ logs: [], total: 0, page: 1, perPage: 0, hasMore: false });
/** Mastra's default logger prints a failed call's output and the vendor's request body. */
const silent: Parameters<Agent["__setLogger"]>[0] = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  trackException() {},
  getTransports: () => new Map(),
  listLogs: noLogs,
  listLogsByRunId: noLogs,
};

/** A task as a Mastra agent, whose model is the one its call puts in the request context. */
function agentOf(task: AgentTask): Agent {
  const tools = task.tools.map(({ id, description, inputSchema, execute }) => {
    return [id, { id, description, inputSchema, execute }] as const;
  });
  const agent = new Agent({
    id: task.name,
    name: task.name,
    instructions: task.prompt.text,
    // The port's model object only: a string would go through Mastra's model router and its fetch.
    model: ({ requestContext }) => {
      const model = requestContext.get(MODEL);
      if (typeof model === "object" && model !== null) return model as Model;
      throw new AppError(aiErrors.ai_model_id_refused, { details: { id: String(model) } });
    },
    tools: Object.fromEntries(tools),
    maxRetries: 0,
    errorProcessorDefaults: false,
  });
  agent.__setLogger(silent);
  return agent;
}

/** The request context of one call, holding the model getModel gave it. */
export const callContext = (model: Model) => new RequestContext([[MODEL, model]]);

/** The LLM port runAgent's models come from: the instance's, else the adapter PROVIDER_LLM names. */
export async function agentLlm(): Promise<Llm> {
  return current?.llm ?? (await getAdapter(llmPort, llmConfig.PROVIDER_LLM));
}

/** The agent runAgent runs for a task: the instance's once there is one, else one of its own. */
export function agentFor(task: AgentTask): Agent {
  if (current === undefined) return agentOf(task);
  // A task registered after the instance was made joins it on its first run.
  const { mastra } = current;
  if (mastra.listAgents()[task.name] === undefined) mastra.addAgent(agentOf(task), task.name);
  return mastra.getAgent(task.name);
}

/**
 * Makes the instance runAgent runs in until its shutdown(), on `llm`. Mastra creates or upgrades
 * its tables in MASTRA_SCHEMA before this returns, connected as `app`.
 */
export async function createMastra({ llm }: { llm: Llm }): Promise<MastraInstance> {
  const pg = new PostgresStore({
    id: "whytide",
    connectionString: databaseUrl("app"),
    schemaName: mastraConfig.MASTRA_SCHEMA,
  });
  // Workflow snapshots and eval scores only: the other domains (memory, traces, Mastra's editor)
  // have columns of the PII registry, `name` and `content` among them, and stay off.
  const storage = new MastraCompositeStore({
    id: "whytide",
    domains: { workflows: pg.stores.workflows, scores: pg.stores.scores, threadState: false },
  });
  const tasks = [...registeredAgentTasks().values()];
  const mastra = new Mastra({
    agents: Object.fromEntries(tasks.map((task) => [task.name, agentOf(task)])),
    storage,
    logger: false,
    // Temporal owns the durable part: no Mastra worker, workflow recovery or scheduled dispatch.
    workers: false,
    recovery: { workflows: "off" },
    notifications: { dispatch: { enabled: false } },
  });
  try {
    await mastra.getStorage()?.init();
  } catch (error) {
    await pg.close();
    throw error;
  }
  const made = { mastra, llm };
  current = made;
  const instance: MastraInstance = {
    async shutdown() {
      if (current === made) current = undefined;
      await mastra.shutdown();
      await pg.close();
    },
  };
  raw.set(instance, mastra);
  return instance;
}
