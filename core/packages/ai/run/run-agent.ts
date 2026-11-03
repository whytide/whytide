// runAgent (README.md "Running a task"): one unit of AI work on Mastra, inside a Temporal activity
// (docs/architecture.md §8). The input goes into the blocks the prompt header names, the budget is
// checked before a model is asked for, the model is the LLM port's, and the raw output comes back
// with what the wrapper (call/call-agent.ts) records; validation, retry and cost events are its.
import "./guard.ts";
import { AppError, allowedAttributes, isAppError, withSpan } from "@whytide/platform";
import type { LlmUsage, llmPort, PortInstance } from "@whytide/providers";
import type { z } from "zod";
import { aiErrors } from "../errors.ts";
import { agentFor, agentLlm, callContext } from "../mastra/instance.ts";
import type { AgentTask } from "../registry/define.ts";
import { estimateTokens } from "./budget.ts";

export type AgentIssue = { readonly path: string; readonly message: string };
/** The raw output, and what callAgent records without working it out again. */
export type AgentRun<O> = {
  readonly task: string;
  readonly promptVersion: number;
  readonly vendor: string;
  readonly modelId: string;
  /** Every model call of the run, from the port's onUsage. */
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  /** The user message as sent, the input in its data blocks; the system prompt is the task's. */
  readonly message: string;
  /** The model's last answer as it came, `""` when there was none. */
  readonly text: string;
} & (
  | { readonly ok: true; readonly output: O }
  /** `invalid` (against the output schema), `empty`, or the finish reason that cut the answer. */
  | { readonly ok: false; readonly reason: string; readonly issues: readonly AgentIssue[] }
);

/** The data block a retry adds after the input's, with the previous attempt's failure. */
export const RETRY_BLOCK = "validation_error";
/** Why an attempt failed, sent back to the model in the retry's data block. */
export type AgentFailure = { readonly reason: string; readonly issues: readonly AgentIssue[] };
export type RunOptions = {
  /** The call's model from agentModel(), shared by its attempts; a model of its own otherwise. */
  readonly model?: AgentModel;
  /** The previous attempt's failure: sent as the data block `<validation_error>` after the input's. */
  readonly retry?: AgentFailure;
};

/**
 * One block of the user message, `<` written `&lt;`. Every tag starts with `<`, so no
 * `</evidence>` of any case or spacing closes a block; `AT&T` and `a>b` arrive as they are.
 */
function renderBlock(block: string, value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  return `<${block}>\n${text.replaceAll("<", "&lt;")}\n</${block}>`;
}

/** The input parsed with the task's input schema, or `ai_input_invalid` naming the fields. */
export function parseAgentInput<I extends z.ZodObject>(task: AgentTask<I>, input: z.input<I>) {
  const parsed = task.inputSchema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new AppError(aiErrors.ai_input_invalid, { details: { task: task.name, fields } });
  }
  return parsed.data;
}

/**
 * The model of one agent call: the task's `model`, else the adapter's first, with its vendor and id
 * known before the call (the cache key) and the tokens of every model call made with it, failed
 * attempts included. One per agent call: `getModel` binds the usage callback to it. The port is
 * `port`, the evals' fake, else agentLlm()'s.
 */
export async function agentModel(task: AgentTask, port?: PortInstance<typeof llmPort>) {
  const llm = port ?? (await agentLlm());
  const modelRef = task.model ?? (await llm.listModels())[0]?.modelId ?? "";
  const usage = { inputTokens: 0, outputTokens: 0 };
  const onUsage = (call: LlmUsage) => {
    usage.inputTokens += call.inputTokens;
    usage.outputTokens += call.outputTokens;
  };
  const { model, vendor, modelId } = await llm.getModel({ modelRef, onUsage });
  return { model, vendor, modelId, usage: usage as LlmUsage };
}
export type AgentModel = Awaited<ReturnType<typeof agentModel>>;

/** A run in a span of its own (alpha-p1-135): the task, the model and the tokens, never a text. */
export function runAgent<I extends z.ZodObject, O extends z.ZodObject>(
  task: AgentTask<I, O>,
  input: z.input<I>,
  options: RunOptions = {},
): Promise<AgentRun<z.output<O>>> {
  const attributes = { task: task.name, module: task.module, prompt_version: task.promptVersion };
  return withSpan("ai.agent_run", attributes, async (span) => {
    const run = await runTask(task, input, options);
    const { vendor, modelId, usage } = run;
    span.setAttributes(
      allowedAttributes({
        vendor,
        model: modelId,
        input_token_count: usage.inputTokens,
        output_token_count: usage.outputTokens,
        outcome: run.ok ? "ok" : run.reason,
      }),
    );
    return run;
  });
}

async function runTask<I extends z.ZodObject, O extends z.ZodObject>(
  task: AgentTask<I, O>,
  input: z.input<I>,
  options: RunOptions,
): Promise<AgentRun<z.output<O>>> {
  const parsed: Record<string, unknown> = parseAgentInput(task, input);
  const blocks = task.prompt.blocks.map((block) => renderBlock(block, parsed[block]));
  if (options.retry) blocks.push(renderBlock(RETRY_BLOCK, options.retry));
  const user = blocks.join("\n\n");
  const estimated = estimateTokens(task.prompt.text) + estimateTokens(user);
  if (estimated > task.budget.maxInputTokens) {
    throw new AppError(aiErrors.ai_budget_exceeded, {
      details: {
        task: task.name,
        estimated_token_count: estimated,
        max_token_count: task.budget.maxInputTokens,
      },
    });
  }
  const { model, vendor, modelId, usage } = options.model ?? (await agentModel(task));
  const before = { ...usage };
  const agent = agentFor(task);
  let text = "";
  const started = performance.now();
  const run = () => ({
    task: task.name,
    promptVersion: task.promptVersion,
    vendor,
    modelId,
    usage: {
      inputTokens: usage.inputTokens - before.inputTokens,
      outputTokens: usage.outputTokens - before.outputTokens,
    },
    latencyMs: Math.round(performance.now() - started),
    message: user,
    text,
  });
  try {
    const result = await agent.generate(user, {
      requestContext: callContext(model),
      structuredOutput: { schema: task.outputSchema },
      modelSettings: { maxOutputTokens: task.budget.maxOutputTokens, maxRetries: 0 },
      // One model call when there is no tool to call; Mastra's default of five steps otherwise.
      ...(task.tools.length === 0 ? { maxSteps: 1 } : {}),
      onStepFinish: (step) => {
        text = step.text;
      },
    });
    if (result.object === undefined) return { ...run(), ok: false, reason: "empty", issues: [] };
    return { ...run(), ok: true, output: result.object as z.output<O> };
  } catch (error) {
    // The port's codes come through as they are; Mastra's own errors carry the prompt, never logged.
    const { id, cause, details } = (error ?? {}) as { id?: unknown; cause?: unknown; details?: {} };
    if (isAppError(error)) throw error;
    if (isAppError(cause)) throw cause;
    if (id === "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED") {
      const { issues = [] } = (cause ?? {}) as {
        issues?: { path: PropertyKey[]; message: string }[];
      };
      const found = issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return { ...run(), ok: false, reason: "invalid", issues: found };
    }
    if (id === "STRUCTURED_OUTPUT_TRUNCATED") {
      const { finishReason } = (details ?? {}) as { finishReason?: unknown };
      return { ...run(), ok: false, reason: String(finishReason), issues: [] };
    }
    const reason = typeof id === "string" ? id : "unknown";
    throw new AppError(aiErrors.ai_agent_failed, { details: { task: task.name, reason } });
  }
}
