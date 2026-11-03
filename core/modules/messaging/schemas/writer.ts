// The writer's data, version 1 (agents/plan-message/README.md, agents/write-message/README.md): the
// two agents' inputs, one field per data block of their prompts, built from the dossier by
// domain/drafts/blocks.ts, and their outputs, whose angles and calls to action are closed lists
// (security §6); and the issues of the gates (domain/gates/), which a regeneration sends back. The
// inputs' objects are allow-lists: callAgent parses an input with its schema and drops any key it
// does not declare before a block is written.
import { z } from "zod";

/** The tasks' names in the agent registry. */
export const PLAN_MESSAGE = "messaging.plan-message";
export const WRITE_MESSAGE = "messaging.write-message";

export const CHANNELS = ["linkedin_note", "linkedin_message"] as const;
export const ANGLES = ["signal_comment", "signal_reaction", "pain_point", "proof_point"] as const;
export const CTAS = ["question", "soft_ask", "resource"] as const;
/** The gates in the order they run: the plan's, then the text's. */
export const GATES = ["facts_used", "placeholders", "length", "grounding", "red_lines"] as const;
export type Channel = (typeof CHANNELS)[number];
export type GateName = (typeof GATES)[number];

/** What a gate found, with the words that failed: its message key is `messaging.gate.<gate>`. */
export const gateIssue = z.discriminatedUnion("gate", [
  z.object({ gate: z.literal("facts_used"), factId: z.string() }),
  z.object({ gate: z.literal("placeholders"), placeholder: z.string() }),
  z.object({ gate: z.literal("length"), length: z.int(), min: z.int(), max: z.int() }),
  z.object({ gate: z.literal("grounding"), entity: z.string() }),
  z.object({ gate: z.literal("red_lines"), phrase: z.string() }),
]);
export type GateIssue = z.output<typeof gateIssue>;

/** A dossier value with its fact id, `{ "f_3": "Signal Radar" }`: one per item, none for null. */
const cited = z.record(z.string().regex(/^f_[1-9][0-9]*$/), z.string());
const blocks = {
  channel: z.object({
    channel: z.enum(CHANNELS),
    minCharacters: z.int(),
    maxCharacters: z.int(),
  }),
  dossier: z.object({
    sender: z.object({ name: cited }),
    offer: z.object({ oneLiner: cited, products: cited, painPoints: cited, proofPoints: cited }),
  }),
  /** Untrusted: the lead's profile and their company's, as LinkedIn has them. */
  lead: z.object({
    firstName: cited,
    headline: cited,
    title: cited,
    location: cited,
    company: z.object({ name: cited, industry: cited, sizeRange: cited, country: cited }),
  }),
  /** Untrusted: the newest three events, a post's words and the lead's comment. */
  why_now: z.array(z.object({ reaction: cited, at: cited, excerpt: cited, comment: cited })).max(3),
};
/**
 * Why this step's earlier answers for the draft failed their gates, one list per answer, oldest
 * first; empty the first time. A regeneration adds its list, so no two calls send the same input
 * and the cache never answers a regeneration; at most two (domain/drafts/write.ts).
 */
const failures = z.array(z.array(gateIssue)).max(2);
/**
 * The draft a regeneration replaces, as the member saw it, null where it had no plan or text; null
 * for a first draft only, so that a regeneration's input is never its first draft's (the cache).
 */
const replaced = z
  .object({
    angle: z.enum(ANGLES).nullable(),
    cta: z.enum(CTAS).nullable(),
    text: z.string().nullable(),
  })
  .nullable();

export const planOutput = z.object({
  angle: z.enum(ANGLES),
  /** The facts the text will use; the facts_used gate checks each against the dossier. */
  factIds: z.array(z.string().max(16)).min(1).max(8),
  cta: z.enum(CTAS),
});
export type PlanOutput = z.output<typeof planOutput>;
export const planInput = z.object({ ...blocks, failures, replaced });
export type PlanInput = z.output<typeof planInput>;

export const writeOutput = z.object({ text: z.string().min(1).max(4_000) });
export const writeInput = z.object({ ...blocks, plan: planOutput, failures, replaced });
export type WriteInput = z.output<typeof writeInput>;
