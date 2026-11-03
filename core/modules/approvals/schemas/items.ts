// The routes' shapes (README.md "Routes"; core/apps/api/README.md "OpenAPI and the client"): the
// item's path parameter, the approval's body, and an item as "Up next" reads it. The lead's names
// and the draft's text are the lead's personal data, shown to the workspace's members only. The
// draft's gates and channel are messaging's words and the tier contacts': open strings here, which
// their READMEs list, so this module never copies their lists.
import { z } from "zod";
import {
  ACTION_TYPES,
  APPROVAL_TEXT_MAX,
  ID_MAX,
  ITEM_STATUSES,
} from "../domain/items/constants.ts";

const id = z.string().min(1).max(ID_MAX);
const time = z.iso.datetime();
export const itemParams = z.strictObject({ id });

/** The owner's final text, `""` for a note left empty; absent, the draft's own. */
export const approveBody = z.strictObject({ text: z.string().max(APPROVAL_TEXT_MAX).optional() });
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
  scheduledFor: time,
  createdAt: time,
  /** Why an approved step waits, a code, and until when if known. */
  waitCode: z.string().nullable(),
  waitUntil: time.nullable(),
  /** The step's local day, in the sender's zone, is before today there. */
  stale: z.boolean(),
  /** Pending 3 days or more. */
  needsAttention: z.boolean(),
  lead: lead.nullable(),
  /** Null while the draft is being written. */
  draft: draft.nullable(),
  sender: z.strictObject({ accountId: id, label: z.string(), timeZone: z.string() }).nullable(),
  /** The caller owns the sender account, so may approve or skip. */
  canDecide: z.boolean(),
});
export type ItemResponse = z.output<typeof itemResponse>;
export const itemsResponse = z.strictObject({
  items: z.array(itemResponse),
  counts: z.strictObject({ toApprove: z.int(), decidedToday: z.int() }),
});
export type ItemsResponse = z.output<typeof itemsResponse>;
