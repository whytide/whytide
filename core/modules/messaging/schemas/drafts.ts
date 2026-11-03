// The draft routes' shapes (README.md "Routes"; core/apps/api/README.md "OpenAPI and the client"):
// the path parameters, the two bodies, and a draft as the lead page reads it (alpha-p9-030): its
// kind, status, plan, texts, generation record and gate results. Its texts are the lead's personal
// data. A sequence step's draft (beta-p3-010) reads back the same way, `approved` included.
import { z } from "zod";
import { ANGLES, CHANNELS, CTAS, GATES, gateIssue } from "./writer.ts";

const id = z.string().min(1).max(64);
export const leadParams = z.strictObject({ personId: id });
export const draftParams = z.strictObject({ id });

export const createDraftBody = z.strictObject({ channel: z.enum(CHANNELS) });
export type CreateDraftBody = z.output<typeof createDraftBody>;
/**
 * The member's own text; the channel's limit is the draft's, and the text, trimmed, passes
 * checkText's gates (domain/drafts/store.ts, domain/gates/check-text.ts; beta-p3-020).
 */
export const editDraftBody = z.strictObject({ editedText: z.string().min(1).max(4_000) });
export type EditDraftBody = z.output<typeof editDraftBody>;

export const DRAFT_STATUSES = [
  "drafting",
  "ready",
  "flagged",
  "failed",
  "edited",
  "approved",
] as const;
/** A lead's draft, alpha's panel's, or a sequence step's, which only approvals' path changes. */
export const DRAFT_KINDS = ["lead_draft", "outbound_step"] as const;
const time = z.iso.datetime();
export const draftResponse = z.strictObject({
  id,
  personId: id,
  channel: z.enum(CHANNELS),
  kind: z.enum(DRAFT_KINDS),
  status: z.enum(DRAFT_STATUSES),
  /** The planner's answer; null until it answered. */
  plan: z
    .strictObject({ angle: z.enum(ANGLES), factIds: z.array(z.string()), cta: z.enum(CTAS) })
    .nullable(),
  text: z.string().nullable(),
  editedText: z.string().nullable(),
  editedAt: time.nullable(),
  /** The last call's model and prompt version, and the dossier's hash, as the draft was written. */
  modelId: z.string().nullable(),
  promptVersion: z.int().nullable(),
  dossierHash: z.string().nullable(),
  /** Each gate's issues, none for a pass: their words are `messaging.gate.<gate>`. */
  gates: z.array(z.strictObject({ gate: z.enum(GATES), issues: z.array(gateIssue) })),
  regenerations: z.int(),
  /** Why a draft is `flagged` (its gates' issues) or `failed` (a code). */
  flagReasons: z.array(z.union([gateIssue, z.strictObject({ code: z.string() })])),
  /** The most characters the channel takes, an edit included: the draft panel's counter. */
  maxCharacters: z.int(),
  createdAt: time,
  updatedAt: time,
});
export type DraftResponse = z.output<typeof draftResponse>;
export const draftListResponse = z.strictObject({ drafts: z.array(draftResponse) });
