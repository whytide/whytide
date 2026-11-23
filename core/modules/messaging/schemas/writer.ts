// The writer's data, version 2 (agents/plan-message/README.md, agents/write-message/README.md): the
// two agents' inputs, one field per data block of their prompts, built from the dossier by
// domain/drafts/blocks.ts, and their outputs, whose angles and calls to action are closed lists
// (security §6); and the issues of the gates (domain/gates/), which a regeneration sends back. The
// inputs' objects are allow-lists: callAgent parses an input with its schema and drops any key it
// does not declare before a block is written. Version 2 adds <step>, a sequence step's (beta-p3-010).
// The email writer (gamma-p3-070), a third agent: the planner's blocks with <channel> an email's, and
// an answer of a subject and a body.
import { z } from "zod";
import { EARLIER_DRAFTS_MAX, STEP_KEYS, WRITTEN_STEP_KINDS } from "../domain/drafts/constants.ts";

/** The tasks' names in the agent registry. */
export const PLAN_MESSAGE = "messaging.plan-message";
export const WRITE_MESSAGE = "messaging.write-message";
export const WRITE_EMAIL = "messaging.write-email";

export const LINKEDIN_CHANNELS = ["linkedin_note", "linkedin_message"] as const;
export const CHANNELS = [...LINKEDIN_CHANNELS, "email"] as const;
/**
 * The channels whose step texts the campaign's mode may approve, each with its AI disclosure line
 * (domain/disclosure/; gamma-p4-080): a LinkedIn message and an email, never a connection request's
 * note.
 */
export const DISCLOSURE_CHANNELS = ["linkedin_message", "email"] as const;
export type DisclosureChannel = (typeof DISCLOSURE_CHANNELS)[number];
export const ANGLES = ["signal_comment", "signal_reaction", "pain_point", "proof_point"] as const;
export const CTAS = ["question", "soft_ask", "resource"] as const;
/**
 * The gates in the order they run: the plan's, then the text's; colleague_signal is beta-p3-020's,
 * the rest gamma-p3-070's: signal_act on every channel, then an email's subject, a first email's
 * links and a step's email against its mailbox's near duplicates.
 */
export const GATES = [
  "facts_used",
  "placeholders",
  "length",
  "grounding",
  "red_lines",
  "colleague_signal",
  "signal_act",
  "subject",
  "links",
  "near_duplicate",
] as const;
export type Channel = (typeof CHANNELS)[number];
export type GateName = (typeof GATES)[number];
/** What is wrong with an email's subject (domain/gates/policies.ts). */
export const SUBJECT_PROBLEMS = [
  "missing",
  "too_long",
  "prefix",
  "line_break",
  "not_allowed",
] as const;
/** What a length counts: a LinkedIn text's issue names none, its unit being characters. */
export const LENGTH_UNITS = ["characters", "words"] as const;

/** What a gate found, with the words that failed: its message key is `messaging.gate.<gate>`. */
export const gateIssue = z.discriminatedUnion("gate", [
  z.object({ gate: z.literal("facts_used"), factId: z.string() }),
  z.object({ gate: z.literal("placeholders"), placeholder: z.string() }),
  z.object({
    gate: z.literal("length"),
    length: z.int(),
    min: z.int(),
    max: z.int(),
    unit: z.enum(LENGTH_UNITS).optional(),
  }),
  z.object({ gate: z.literal("grounding"), entity: z.string() }),
  z.object({ gate: z.literal("red_lines"), phrase: z.string() }),
  /** The words that hit, as the text wrote them: a phrase of a colleague, or a colleague's name. */
  z.object({ gate: z.literal("colleague_signal"), phrase: z.string() }),
  /** The words that name the signal's act, as the text wrote them. */
  z.object({ gate: z.literal("signal_act"), phrase: z.string() }),
  z.object({ gate: z.literal("subject"), problem: z.enum(SUBJECT_PROBLEMS) }),
  /** The link as the text wrote it. */
  z.object({ gate: z.literal("links"), link: z.string() }),
  /** The highest similarity to another draft of the mailbox, 0 to 1: never the other text. */
  z.object({ gate: z.literal("near_duplicate"), similarity: z.number().min(0).max(1) }),
]);
export type GateIssue = z.output<typeof gateIssue>;

/** A dossier value with its fact id, `{ "f_3": "Signal Radar" }`: one per item, none for null. */
const cited = z.record(z.string().regex(/^f_[1-9][0-9]*$/), z.string());
/** A LinkedIn text's channel: the characters it may have. */
const linkedinChannel = z.object({
  channel: z.enum(LINKEDIN_CHANNELS),
  minCharacters: z.int(),
  maxCharacters: z.int(),
});
/** An email's: the words of its body, and a first email's subject's limits, null for a follow-up. */
const emailChannel = z.object({
  channel: z.literal("email"),
  minWords: z.int(),
  maxWords: z.int(),
  subject: z.object({ maxWords: z.int(), maxCharacters: z.int() }).nullable(),
});
export type EmailChannelBlock = z.output<typeof emailChannel>;
export type LinkedinChannelBlock = z.output<typeof linkedinChannel>;
/** The planner's and the writers' blocks; the reply writer's dossier blocks too (reply.ts). */
export const blocks = {
  channel: z.discriminatedUnion("channel", [linkedinChannel, emailChannel]),
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
/**
 * The sequence's step the text is for (domain/drafts/write.ts): its kind, and the same person's
 * earlier approved texts of the sequence, oldest first, empty ones left out. Absent for a lead's
 * draft, so alpha's inputs, its eval cases among them, stay valid. Untrusted: a member may have
 * edited the texts.
 */
const step = z
  .object({
    kind: z.enum(WRITTEN_STEP_KINDS),
    earlier: z
      .array(z.object({ stepKey: z.enum(STEP_KEYS), text: z.string().min(1) }))
      .max(EARLIER_DRAFTS_MAX),
  })
  .nullable()
  .optional();
export type StepBlock = NonNullable<z.output<typeof step>>;

export const planOutput = z.object({
  angle: z.enum(ANGLES),
  /** The facts the text will use; the facts_used gate checks each against the dossier. */
  factIds: z.array(z.string().max(16)).min(1).max(8),
  cta: z.enum(CTAS),
});
export type PlanOutput = z.output<typeof planOutput>;
export const planInput = z.object({ ...blocks, step, failures, replaced });
export type PlanInput = z.output<typeof planInput>;

export const writeOutput = z.object({ text: z.string().min(1).max(4_000) });
export const writeInput = z.object({
  ...blocks,
  channel: linkedinChannel,
  step,
  plan: planOutput,
  failures,
  replaced,
});
export type WriteInput = z.output<typeof writeInput>;

/** An email: a first one's subject, null for a follow-up, which goes in its thread; its body. */
export const writeEmailOutput = z.object({
  subject: z.string().max(4_000).nullable(),
  body: z.string().min(1).max(4_000),
});
export type WriteEmailOutput = z.output<typeof writeEmailOutput>;
export const writeEmailInput = z.object({
  ...blocks,
  channel: emailChannel,
  step,
  plan: planOutput,
  failures,
  replaced,
});
