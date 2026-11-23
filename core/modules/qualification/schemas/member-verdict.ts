// A member's verdict on one criterion of a lead's current snapshot (README "A member's verdict"), as
// `PUT …/qualification/leads/{personId}/verdicts/{criterion}` takes it; `DELETE` takes the params
// alone. Both answer the snapshot read again (schemas/snapshot.ts).
import { z } from "zod";
import { MEMBER_NOTE_MAX } from "../domain/score/constants.ts";
import { CRITERIA, VERDICTS } from "./assess-fit.ts";

export const memberVerdictParams = z.strictObject({
  personId: z.string().min(1).max(64),
  criterion: z.enum(CRITERIA),
});
/** The verdict, and the note, trimmed; an empty one is none. */
export const memberVerdictBody = z.strictObject({
  verdict: z.enum(VERDICTS),
  note: z.string().max(MEMBER_NOTE_MAX).optional(),
});
export type MemberVerdictBody = z.infer<typeof memberVerdictBody>;
