// The answer of qualification's snapshot read (README.md "Routes"), from which the api builds its
// OpenAPI document: the lead's current snapshot with its audience, its time as an ISO string, and
// the lead's intent, or null, its times ISO strings too.
import { z } from "zod";
import { COUNTED_ROLES, INTENT_KINDS } from "../domain/intent/constants.ts";
import { CRITERIA, DISQUALIFIERS, VERDICTS } from "./assess-fit.ts";

const tier = z.enum(["hot", "warm", "cool"]);
const kind = z.enum(INTENT_KINDS);
const role = z.enum(COUNTED_ROLES);
/** A signal's date; null in a row written before gamma-p5-065. */
const at = z.string().nullable();

export const snapshotParams = z.strictObject({ personId: z.string().min(1).max(64) });
/** The lead's intent, priority and tier (README "Intent and priority"); the tier is the lead's. */
export const snapshotIntent = z.strictObject({
  intentScore: z.int(),
  priority: z.int(),
  tier: tier.nullable(),
  /** The strongest signal, the why's why-now bullet; null without one. */
  whyNow: z.strictObject({ kind, role, at }).nullable(),
  boostUntil: z.string().nullable(),
  /** Each signal that counts with its term of the intent, newest first. */
  breakdown: z.array(
    z.strictObject({ eventId: z.string(), kind, role, contribution: z.number(), at }),
  ),
  scorerVersion: z.string(),
  computedAt: z.string(),
});
export const snapshotResponse = z.strictObject({
  snapshotId: z.string(),
  personId: z.string(),
  /**
   * The audience the lead was judged against (gamma-p5-050): its name, empty when unnamed, and
   * whether it is the workspace's default; null when icp no longer holds it or the row names none.
   */
  audience: z.strictObject({ id: z.string(), name: z.string(), isDefault: z.boolean() }).nullable(),
  status: z.enum(["assessed", "qualified", "not_qualified", "needs_review"]),
  fitScore: z.int().nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  /** The fit's tier, which the snapshot keeps. */
  tier: tier.nullable(),
  icpVersion: z.int(),
  scorerVersion: z.string().nullable(),
  /** The model's one sentence; the screen labels it as the model's. */
  summary: z.string(),
  disqualifiers: z.array(z.enum(DISQUALIFIERS)),
  /**
   * A verdict per criterion in the criteria's order (README "A member's verdict"): `verdict` is the
   * one that counts, the member's when set, else the model's (`modelVerdict`, null when the model
   * gave none); both null for a criterion without a row. Weight and points are null until scored.
   */
  verdicts: z.array(
    z.strictObject({
      criterion: z.enum(CRITERIA),
      verdict: z.enum(VERDICTS).nullable(),
      modelVerdict: z.enum(VERDICTS).nullable(),
      evidence: z.string(),
      weight: z.int().nullable(),
      points: z.number().nullable(),
      /** The member's verdict, its note, who set it (`mine` when the reader did) and when. */
      member: z
        .strictObject({
          verdict: z.enum(VERDICTS),
          note: z.string().nullable(),
          setBy: z.string(),
          setAt: z.string(),
          mine: z.boolean(),
        })
        .nullable(),
    }),
  ),
  scoredAt: z.string(),
  /** Null without an intent row: no signal reader, or no decision yet. */
  intent: snapshotIntent.nullable(),
});
export type SnapshotResponse = z.infer<typeof snapshotResponse>;
