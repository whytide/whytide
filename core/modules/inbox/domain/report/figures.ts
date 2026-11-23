// The reply numbers (README.md "The report"; gamma-p7-060), pure: the facts of every workspace read
// (read.ts) in, the figures out, added up here, never in one query across workspaces. Counts and
// shares only; a share with nothing to count is null.
import { DAY_MS } from "../export/constants.ts";
import { POSITIVE_CLASS } from "../labels/constants.ts";
import {
  AGREEMENT_MIN_REPLIES,
  BETA_POSITIVE,
  LINKEDIN_CHANNEL,
  NOT_HUMAN_LABELS,
  OPT_OUT_CLASS,
  POSITIVE_REPEAT_DAYS,
} from "./constants.ts";
import type { ReplyFact, WorkspaceFacts } from "./read.ts";
import { isoWeek } from "./week.ts";

export type ReplyRate = {
  readonly touched: number;
  readonly replied: number;
  readonly share: number | null;
};
/** A workspace's week with at least one send, and the leads whose first positive event fell in it. */
export type PositiveWeek = {
  readonly workspaceId: string;
  readonly week: string;
  readonly positives: number;
};
export type PositiveConversations = {
  readonly weeks: readonly PositiveWeek[];
  /** The mean of the weeks' positives; null with no active week. */
  readonly mean: number | null;
};
export type Agreement =
  | { readonly pairs: number; readonly tooFew: true }
  | {
      readonly pairs: number;
      readonly tooFew: false;
      readonly f1Interested: number | null;
      readonly optOutShare: number | null;
    };
export type Figures = {
  readonly replyRateLinkedin: ReplyRate;
  readonly positive: PositiveConversations;
  readonly agreement: Agreement;
};

const notHuman: readonly string[] = NOT_HUMAN_LABELS;
const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** The figures of the workspaces, the touches and replies from `since`. */
export function figures(facts: readonly WorkspaceFacts[], since: Date): Figures {
  const recent = (reply: ReplyFact) => reply.sentAt.getTime() >= since.getTime();
  return {
    replyRateLinkedin: replyRate(facts, LINKEDIN_CHANNEL, recent),
    positive: positiveConversations(facts),
    agreement: agreement(facts.flatMap(({ replies }) => replies.filter(recent))),
  };
}

/**
 * The reply's current label: the thread owner's class, beta's `positive` as the positive class, else
 * the classification's; null for none. An owner's label overrides the model's (requirements/11 §2.1).
 */
export function currentLabel(reply: ReplyFact): string | null {
  if (reply.owner?.classLabel) return reply.owner.classLabel;
  if (reply.owner?.label === BETA_POSITIVE) return POSITIVE_CLASS;
  return reply.classification?.label ?? null;
}

/** A human reply: its current label neither out_of_office nor bounce; an unclassified one counts. */
export const isHuman = (reply: ReplyFact): boolean => {
  const label = currentLabel(reply);
  return label === null || !notHuman.includes(label);
};

/** The owner chose the positive class, or beta's `positive` on a row with no class. */
const ownerPositive = (owner: NonNullable<ReplyFact["owner"]>): boolean =>
  owner.classLabel === null ? owner.label === BETA_POSITIVE : owner.classLabel === POSITIVE_CLASS;

/**
 * A positive event: the owner's positive label; where no owner labeled the reply, the classifier's
 * `interested` when not suggested. An owner's other label cancels the model's.
 */
export function isPositive(reply: ReplyFact): boolean {
  if (reply.owner !== null) return ownerPositive(reply.owner);
  const { classification } = reply;
  return classification?.label === POSITIVE_CLASS && !classification.isSuggested;
}

/**
 * Among signal-sourced leads, those with a human reply on the channel, among those touched, ÷ those
 * touched. A reply counts from `since`, as the touches do.
 */
export function replyRate(
  facts: readonly WorkspaceFacts[],
  channel: string,
  recent: (reply: ReplyFact) => boolean,
): ReplyRate {
  let touched = 0;
  let replied = 0;
  for (const { touches, replies, signal } of facts) {
    const leads = new Set(touches.map(({ personId }) => personId).filter((id) => signal.has(id)));
    const humans = new Set(
      replies
        .filter((reply) => reply.channel === channel && recent(reply) && isHuman(reply))
        .map(({ personId }) => personId),
    );
    touched += leads.size;
    replied += [...leads].filter((personId) => humans.has(personId)).length;
  }
  return { touched, replied, share: share(replied, touched) };
}

/**
 * The instants of each lead's counted positive events: the first, then the next one at least
 * POSITIVE_REPEAT_DAYS after the last counted, so a lead counts once in any 90 days.
 */
export function countedPositives(replies: readonly ReplyFact[]): Date[] {
  const byLead = Map.groupBy(replies.filter(isPositive), ({ personId }) => personId);
  const repeat = POSITIVE_REPEAT_DAYS * DAY_MS;
  const counted: Date[] = [];
  for (const events of byLead.values()) {
    let last: number | undefined;
    for (const at of events.map(({ sentAt }) => sentAt.getTime()).sort((a, b) => a - b)) {
      if (last !== undefined && at - last < repeat) continue;
      counted.push(new Date(at));
      last = at;
    }
  }
  return counted;
}

/**
 * Each workspace's active weeks, those with a touch, with the leads whose first positive event fell
 * in them, by workspace then week; the mean over those workspace-weeks. A week with no touch leaves
 * the workspace out of the mean, its positives too.
 */
export function positiveConversations(facts: readonly WorkspaceFacts[]): PositiveConversations {
  const weeks: PositiveWeek[] = [];
  for (const { workspaceId, touches, replies } of facts) {
    const active = [...new Set(touches.map(({ at }) => isoWeek(at)))].sort();
    const positives = countedPositives(replies).map(isoWeek);
    for (const week of active) {
      const count = positives.filter((positive) => positive === week).length;
      weeks.push({ workspaceId, week, positives: count });
    }
  }
  const total = weeks.reduce((sum, { positives }) => sum + positives, 0);
  return { weeks, mean: share(total, weeks.length) };
}

/**
 * On the replies with both an owner's label and a classification: the F1 of the classifier's
 * `interested` against the owner's positive, and the share of the owner's `opt_out` replies
 * classified `opt_out`; too_few under AGREEMENT_MIN_REPLIES pairs.
 */
export function agreement(replies: readonly ReplyFact[]): Agreement {
  const pairs = replies.flatMap(({ owner, classification }) =>
    owner === null || classification === null ? [] : [{ owner, classification }],
  );
  if (pairs.length < AGREEMENT_MIN_REPLIES) return { pairs: pairs.length, tooFew: true };
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0, optOut: 0, caught: 0 };
  for (const { owner, classification } of pairs) {
    const truth = ownerPositive(owner);
    const said = classification.label === POSITIVE_CLASS;
    if (truth && said) counts.truePositive += 1;
    else if (said) counts.falsePositive += 1;
    else if (truth) counts.falseNegative += 1;
    if (owner.classLabel !== OPT_OUT_CLASS) continue;
    counts.optOut += 1;
    if (classification.label === OPT_OUT_CLASS) counts.caught += 1;
  }
  const { truePositive, falsePositive, falseNegative, optOut, caught } = counts;
  return {
    pairs: pairs.length,
    tooFew: false,
    f1Interested: share(2 * truePositive, 2 * truePositive + falsePositive + falseNegative),
    optOutShare: share(caught, optOut),
  };
}
