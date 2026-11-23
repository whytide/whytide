// A lead's rules (docs/concepts.md "Lead"), pure: the values a lead takes, the merge of a new
// source into its list, and the list's cursor, opaque to the caller, built from the sort key and
// the person id so that a page starts exactly after the one before, whatever the ties.
import { z } from "zod";
import { REVIEW_DECISIONS, type ReviewDecisionKind } from "./review/rules.ts";

export const QUALIFICATION_STATUSES = [
  "pending",
  "hard_filtered",
  "qualified",
  "not_qualified",
  "needs_review",
  "ai_failed",
] as const;
/** A signal's, an import's or a member's by hand (lead-create.ts), whose `ref` is their user id. */
export const SOURCE_KINDS = ["signal", "imported", "manual"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const TIERS = ["hot", "warm", "cool"] as const;
/** By descending fit, newest first, or the leads without a review decision first, then by fit. */
export const LEAD_SORTS = ["fit", "newest", "unreviewed_first"] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Tier = (typeof TIERS)[number];
export type LeadSort = (typeof LEAD_SORTS)[number];

/**
 * One source of a lead: its kind, the id of what brought it (an import job, a signal source, the
 * member who added it by hand), when, and, as the module that adds it gives them, its name as that
 * module shows it and an https URL (a signal source's label and post). An entry stored before has
 * neither, and a member's has none.
 */
export type LeadSource = {
  readonly kind: SourceKind;
  readonly ref: string;
  readonly at: string;
  readonly label?: string;
  readonly url?: string;
};
/** A why bullet as qualification writes it: a message key and its values (alpha-p6-030). */
export type WhyBullet = {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
};

/** The label and the URL given, none as `undefined`: the JSON column keeps no empty key. */
const named = ({ label, url }: { label?: string | undefined; url?: string | undefined }) => ({
  ...(label === undefined ? {} : { label }),
  ...(url === undefined ? {} : { url }),
});

/** The entry of a source as a command takes it: its time, now unless given; its label and URL if any. */
export function sourceEntry(source: {
  kind: SourceKind;
  ref: string;
  at?: Date;
  label?: string;
  url?: string;
}): LeadSource {
  const { kind, ref, at = new Date() } = source;
  return { kind, ref, at: at.toISOString(), ...named(source) };
}

/**
 * The sources once `source` arrives: appended, unless one of its kind and ref is there already,
 * which keeps its place and time and takes the label and the URL `source` gives, each where given,
 * so that a renamed source names its next lead anew. The same list when nothing changes.
 */
export function mergeSource(
  sources: readonly LeadSource[],
  source: LeadSource,
): readonly LeadSource[] {
  const known = sources.find(({ kind, ref }) => kind === source.kind && ref === source.ref);
  if (known === undefined) return [...sources, source];
  const renamed = { ...known, ...named(source) };
  if (renamed.label === known.label && renamed.url === known.url) return sources;
  return sources.map((entry) => (entry === known ? renamed : entry));
}

/**
 * The ref of the lead's first source of kind `signal`, the signal source that found it first; none
 * for a lead no signal brought. leadsPendingQualification's filters read it in SQL the same way
 * (FIRST_SIGNAL_PATH), so qualification's audience of a lead and its batch's selection agree.
 */
export function firstSignalSource(sources: readonly LeadSource[]): string | undefined {
  return sources.find(({ kind }) => kind === "signal")?.ref;
}

/** Where a page ends in its sort: the last lead's sort key and person id. */
export type LeadCursor =
  | { readonly sort: "fit"; readonly fitScore: number | null; readonly personId: string }
  | { readonly sort: "newest"; readonly createdAt: Date; readonly personId: string }
  | {
      readonly sort: "unreviewed_first";
      readonly reviewStatus: ReviewDecisionKind | null;
      readonly fitScore: number | null;
      readonly personId: string;
    };

const personId = z.string().min(1).max(64);
const fit = z.int().min(0).max(100).nullable();
const cursorShape = z.union([
  z.tuple([z.literal("fit"), fit, personId]),
  z.tuple([z.literal("newest"), z.iso.datetime(), personId]),
  z.tuple([z.literal("unreviewed_first"), z.enum(REVIEW_DECISIONS).nullable(), fit, personId]),
]);

/** What a lead's place in a sort is made of. */
type Positioned = {
  readonly personId: string;
  readonly fitScore: number | null;
  readonly createdAt: Date;
  readonly reviewStatus: ReviewDecisionKind | null;
};

/** The lead's place in the sort. */
export function positionOf(sort: LeadSort, lead: Positioned): LeadCursor {
  const { personId, fitScore } = lead;
  if (sort === "fit") return { sort, fitScore, personId };
  if (sort === "newest") return { sort, createdAt: lead.createdAt, personId };
  return { sort, reviewStatus: lead.reviewStatus, fitScore, personId };
}

/** The cursor after `lead` in the sort: base64url of `[sort, ...keys, personId]`. */
export function encodeCursor(sort: LeadSort, lead: Positioned): string {
  const at = positionOf(sort, lead);
  const keys =
    at.sort === "fit"
      ? [at.fitScore]
      : at.sort === "newest"
        ? [at.createdAt.toISOString()]
        : [at.reviewStatus, at.fitScore];
  return Buffer.from(JSON.stringify([sort, ...keys, lead.personId])).toString("base64url");
}

/** The position the cursor names in the sort; null when malformed or made in the other sort. */
export function decodeCursor(sort: LeadSort, cursor: string): LeadCursor | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = cursorShape.safeParse(value);
  if (!parsed.success || parsed.data[0] !== sort) return null;
  const data = parsed.data;
  if (data[0] === "fit") return { sort: "fit", fitScore: data[1], personId: data[2] };
  if (data[0] === "newest") {
    return { sort: "newest", createdAt: new Date(data[1]), personId: data[2] };
  }
  return { sort: data[0], reviewStatus: data[1], fitScore: data[2], personId: data[3] };
}
