// The setup the classifier's test files share (tests/classify.test.ts,
// tests/safety/classify-opt-out.test.ts), on the file's schema (withTestDb, called by the file) and
// the LLM fake: the task registered from its sources, a reply stored by the store's run, the
// classifier run as the worker's activity runs it, the model's answers, and the rows as the tests
// read them.
import assert from "node:assert/strict";
import { loadAgentTasks } from "@whytide/ai";
import { getAdapter, type LlmFake, llmPort } from "@whytide/providers";
import {
  type Classified,
  type ClassifyContext,
  type ClassifyRequest,
  classifyFallback,
  classifyReply,
} from "../domain/classify/classify.ts";
import { storeInbound } from "../domain/store/store.ts";
import { type Fixture, fixture, replyFile } from "./fixtures.ts";

await loadAgentTasks([new URL("../agents/classify-reply/task.ts", import.meta.url).href]);
export const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};
const MINUTE_MS = 60_000;

/** A model's answer, as the fake gives it. */
export const answer = (label: string, confidence: number, returnDate: string | null = null) => ({
  label,
  confidence,
  returnDate,
});

/** A classification as the tests read it. */
export type ClassificationRow = {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  readonly isSuggested: boolean;
  readonly optOutDetected: boolean;
  readonly origin: string;
  readonly entities: unknown;
  readonly decisionRecordId: string | null;
  readonly modelId: string | null;
  readonly promptVersion: number | null;
  readonly actionsTaken: unknown;
};
export type ClassifyFixture = Fixture & {
  readonly context: ClassifyContext;
  readonly reply: (
    personId: string,
    senderAccountId: string,
    text: string,
    given?: { minutesAgo?: number },
  ) => Promise<ClassifyRequest>;
  /** A person enrolled on a new account of `ownerUserId` (OWNER's by default), as STEPS has them. */
  readonly person: (
    slug: string,
    ownerUserId?: string,
  ) => Promise<{ senderAccountId: string; personId: string }>;
  readonly classify: (request: ClassifyRequest) => Promise<Classified>;
  /** The fallback the workflow stores past the classifier's attempts. */
  readonly fallBack: (request: ClassifyRequest) => Promise<Classified>;
  readonly rowOf: (messageId: string) => Promise<ClassificationRow>;
  /** The workspace's active opt-outs, by channel. */
  readonly optOutChannels: () => Promise<string[]>;
};

/** The workspace's fixture, with the classifier's helpers. */
export function classifyFixture(workspaceId: string): ClassifyFixture {
  const base: Fixture = fixture(workspaceId);
  const context = { workspaceId, tenant: base.run, call: { client: base.app(), prices } };
  /** A reply stored by the store's run in a thread of its own, sent `minutesAgo` before now: its ids. */
  const reply: ClassifyFixture["reply"] = async (personId, senderAccountId, text, given = {}) => {
    const sentAt = new Date(Date.now() - (given.minutesAgo ?? 0) * MINUTE_MS).toISOString();
    const file = replyFile(text, { sentAt });
    const now = new Date();
    const stored = await base.run(() => storeInbound({ personId, senderAccountId, file, now }));
    const message = (await base.messages()).find(({ id }) => id === stored.messageId);
    assert.ok(message, "the reply is stored");
    return { messageId: message.id, threadId: message.threadId, personId };
  };
  const person: ClassifyFixture["person"] = async (slug, ownerUserId) => {
    const { id: senderAccountId } = await base.account(ownerUserId);
    return { senderAccountId, personId: await base.enrolled(senderAccountId, slug) };
  };
  return {
    ...base,
    context,
    reply,
    person,
    classify: (request: ClassifyRequest) => classifyReply(context, request),
    fallBack: (request: ClassifyRequest) => classifyFallback(context, request),
    rowOf: (messageId) => base.app().replyClassification.findFirstOrThrow({ where: { messageId } }),
    optOutChannels: async () =>
      (
        await base.app().suppressionEntry.findMany({
          where: { workspaceId, layer: "opt_out", removedAt: null },
        })
      ).map(({ channel }) => channel),
  };
}
