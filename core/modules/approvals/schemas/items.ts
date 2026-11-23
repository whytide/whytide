// The routes' shapes (README.md "Routes"; core/apps/api/README.md "OpenAPI and the client"): the
// item's path parameter, the approval's body, and an item as "Up next" reads it, an email's with its
// mailbox and subject (gamma-p4-090), with the caller's senders and their counts (gamma-p6-050). The
// lead's names and the draft's text and subject are the lead's personal data, shown to the sender's
// owner only. The draft's gates and channel are messaging's words and the tier contacts': open
// strings here, which their READMEs list, so this module never copies their lists.
import { z } from "zod";
import {
  ACTION_TYPES,
  APPROVAL_BY,
  APPROVAL_TEXT_MAX,
  CHANNELS,
  ID_MAX,
  ITEM_STATUSES,
} from "../domain/items/constants.ts";

const id = z.string().min(1).max(ID_MAX);
const time = z.iso.datetime();
export const itemParams = z.strictObject({ id });

export const approveBody = z.strictObject({
  /** The owner's final text, `""` for a note left empty; absent, the draft's own. */
  text: z.string().max(APPROVAL_TEXT_MAX).optional(),
  /** A first email's final subject; absent, the draft's own. An email item's only. */
  subject: z.string().max(APPROVAL_TEXT_MAX).optional(),
  /** The draft the screen showed: another attached draft answers approval_draft_changed. */
  draftId: id.optional(),
});
export type ApproveBody = z.output<typeof approveBody>;

/** A gate's issue as messaging writes it: the gate, and what it found (its README "The writer"). */
const gateIssue = z.looseObject({ gate: z.string() });
const lead = z.strictObject({
  personId: id,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  companyName: z.string().nullable(),
  /** `hot`, `warm` or `cool`; null before the lead is scored. */
  tier: z.string().nullable(),
  /** The first why bullet: a message key and its values, as the leads list renders it. */
  why: z
    .strictObject({
      key: z.string(),
      params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    })
    .nullable(),
});
/** messaging's view of a step's draft (stepDrafts). */
const draft = z.strictObject({
  id,
  personId: id,
  stepExecutionId: id,
  stepKey: z.string(),
  channel: z.string(),
  status: z.string(),
  /** The final text, the owner's else the writer's; null for a failed draft. */
  text: z.string().nullable(),
  minCharacters: z.int(),
  maxCharacters: z.int(),
  /** A first email's final subject, and its limits; null for any other draft. */
  subject: z.string().nullable(),
  maxSubjectWords: z.int().nullable(),
  maxSubjectCharacters: z.int().nullable(),
  gates: z.array(z.strictObject({ gate: z.string(), issues: z.array(gateIssue) })),
  /** Why it is flagged (its gates' issues) or failed (a code). */
  flagReasons: z.array(z.union([gateIssue, z.strictObject({ code: z.string() })])),
  factIds: z.array(z.string()),
  editedByUser: z.boolean(),
  editRatio: z.number().nullable(),
  approvedAt: time.nullable(),
});
export const itemResponse = z.strictObject({
  id,
  status: z.enum(ITEM_STATUSES),
  stepKey: z.string(),
  actionType: z.enum(ACTION_TYPES),
  /** LinkedIn's, or an email's. */
  channel: z.enum(CHANNELS),
  /** An email item's mailbox, its sender; null on LinkedIn. */
  mailboxId: id.nullable(),
  /** Who approves it: a person, or the campaign's mode once its draft is ready. */
  approvalBy: z.enum(APPROVAL_BY),
  scheduledFor: time,
  createdAt: time,
  /** Why an approved step waits, a code, and until when if known; `mode_declined` on a pending one. */
  waitCode: z.string().nullable(),
  waitUntil: time.nullable(),
  /** The step's local day, in the sender's zone, is before today there. */
  stale: z.boolean(),
  /** Pending 3 days or more. */
  needsAttention: z.boolean(),
  lead: lead.nullable(),
  /** Null while the draft is being written. */
  draft: draft.nullable(),
  /** The account, or an email's mailbox by its address, with no account; null once it is gone. */
  sender: z
    .strictObject({ accountId: id.nullable(), label: z.string(), timeZone: z.string() })
    .nullable(),
  /** The caller owns the sender, the account or the mailbox, so may approve or skip. */
  canDecide: z.boolean(),
});
export type ItemResponse = z.output<typeof itemResponse>;
/** One of the caller's senders, an account or an email's mailbox, with its counts (gamma-p6-050). */
const senderCounts = z.strictObject({
  /** The account's id; null for a mailbox. */
  accountId: id.nullable(),
  /** The mailbox's id; null for an account. */
  mailboxId: id.nullable(),
  /** The account's label, or the mailbox's address. */
  label: z.string(),
  timeZone: z.string(),
  /** Its pending items, past the list's cap too. */
  toApprove: z.int(),
  /** Its items a person approved or skipped since the start of today in its own zone. */
  decidedToday: z.int(),
});
export const itemsResponse = z.strictObject({
  items: z.array(itemResponse),
  /** The caller's own senders, by label. */
  senders: z.array(senderCounts),
  /** The senders' sums. */
  counts: z.strictObject({ toApprove: z.int(), decidedToday: z.int() }),
});
export type ItemsResponse = z.output<typeof itemsResponse>;
