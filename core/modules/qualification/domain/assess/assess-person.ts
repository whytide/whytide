// assessPerson, the command the batch (alpha-p6-040) calls in its activity, and erasePerson (README.md
// "Public interface", docs/flows.md). One tenant run reads the person, the company and the ICP and
// builds the anonymized input; callAgent asks the model outside any run, since it opens its own for
// the result cache and the decision record; a second run writes the snapshot and its six verdicts,
// once per decision record and ICP version: a retried activity, which the cache answers, finds them,
// and one that loses the insert to a concurrent activity reads them.
// The hard filters ran before: the caller passes only persons who passed them. Nothing here logs, so
// the profile, the evidence, the prompt and the output stay out of every log line.
import { agentModel, type CallOptions, callAgent, registeredAgentTasks } from "@whytide/ai";
import { getCompany, getPerson } from "@whytide/contacts";
import { type TenantClient, tenantClient } from "@whytide/db";
import { type Icp, readIcpForScoring } from "@whytide/icp";
import { type ActivityContext, AppError, newId } from "@whytide/platform";
import { z } from "zod";
import type { assessFitTask } from "../../agents/assess-fit/task.ts";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import {
  ASSESS_FIT,
  type AssessFitInput,
  type CriterionVerdict,
  type Disqualifier,
} from "../../schemas/assess-fit.ts";
import {
  type AnonymizerCompany,
  type AnonymizerPerson,
  anonymizeForAssessment,
} from "../anonymize/index.ts";
import { groundVerdicts } from "./checks.ts";

/** Where assessPerson runs: the activity's workspace and tenant runs; callAgent's options in a test. */
export type AssessContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant"> & {
  readonly call?: CallOptions;
};
export type AssessResult =
  | {
      readonly status: "assessed";
      readonly snapshotId: string;
      readonly verdicts: CriterionVerdict[];
      readonly disqualifiers: Disqualifier[];
    }
  | { readonly status: "ai_failed"; readonly reason: string; readonly decisionRecordId: string };

const personId = z.string().min(1).max(64);
const assessInput = z.object({
  personId,
  icpVersion: z.number().int().positive(),
  /** Signals' excerpts (alpha-p8-030); none for an imported person. */
  evidence: z.array(z.string()).optional(),
});

/**
 * The person assessed against the workspace's ICP at `icpVersion`: the snapshot and its verdicts as
 * stored, each grounded in the person's data or unknown; or ai_failed, with nothing stored but the
 * wrapper's decision record. icp_version_stale when the ICP moved; contacts' person_not_found.
 */
export async function assessPerson(
  input: z.input<typeof assessInput>,
  context: AssessContext,
): Promise<AssessResult> {
  const { personId, icpVersion, evidence } = parse(assessInput, input);
  const task = registeredTask();
  const { workspaceId } = context;
  const blocks = await context.tenant(async (): Promise<AssessFitInput> => {
    const person = await getPerson(personId);
    const company = person.companyId === null ? null : await getCompany(person.companyId);
    const { icp } = await readIcpForScoring(workspaceId);
    if (icp.version !== icpVersion) {
      const details = { icp_version: icpVersion, current_version: icp.version };
      throw new AppError(errors.icp_version_stale, { details });
    }
    return assessmentInput(person, company, icp, evidence);
  });
  const call = { workspaceId, subjectRef: personId, input: blocks };
  const result = await callAgent(task, call, context.call);
  if (result.status === "ai_failed") {
    const { reason, decisionRecordId } = result;
    return { status: "ai_failed", reason, decisionRecordId };
  }
  const { output, decisionRecordId } = result;
  const verdicts = groundVerdicts(output, blocks);
  const disqualifiers = [...new Set(output.disqualifiers)];
  const { modelId } = await agentModel(task);
  // The assessment's own snapshot; a re-score's copies carry their criteria's hash (rescore.ts).
  const where = { decisionRecordId, icpVersion, criteriaHash: "" };
  const select = { id: true } as const;
  const snapshotId = await context
    .tenant(async (tx) => {
      const stored = await tx.scoreSnapshot.findFirst({ where, select });
      if (stored !== null) return stored.id;
      const id = newId(ids.score_snapshot);
      const { promptVersion } = task;
      const { summary } = output;
      const snapshot = { workspaceId, personId, icpVersion, modelId, promptVersion, summary };
      await tx.scoreSnapshot.create({ data: { ...snapshot, id, disqualifiers, decisionRecordId } });
      const rows = verdicts.map((verdict) => ({
        ...verdict,
        id: newId(ids.criterion_verdict),
        workspaceId,
        snapshotId: id,
      }));
      await tx.criterionVerdict.createMany({ data: rows });
      return id;
    })
    .catch(async (error: unknown) => {
      // P2002, the key: another activity on this decision record inserted the snapshot after this
      // run's read, which aborted this run; a run of its own reads the stored one.
      if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
      const read = (tx: TenantClient) => tx.scoreSnapshot.findFirstOrThrow({ where, select });
      return (await context.tenant(read)).id;
    });
  return { status: "assessed", snapshotId, verdicts, disqualifiers };
}

/** What the input reads of the ICP: its targeting and its two texts. */
type InputIcp = Pick<
  Icp,
  | "titles"
  | "seniorities"
  | "industries"
  | "sizeRanges"
  | "countries"
  | "mustHaves"
  | "disqualifiers"
>;

/**
 * The agent's input for one person, pure: the anonymized blocks (domain/anonymize/) and the ICP's.
 * assessPerson sends it; the golden set rebuilds it from the stored records (domain/export/).
 */
export function assessmentInput(
  person: AnonymizerPerson,
  company: AnonymizerCompany | null,
  icp: InputIcp,
  evidence?: readonly string[],
): AssessFitInput {
  const { titles, seniorities, industries, sizeRanges, countries } = icp;
  return {
    ...anonymizeForAssessment(person, company, evidence),
    icp: {
      titles: [...titles],
      seniorities: [...seniorities],
      industries: [...industries],
      company_sizes: [...sizeRanges],
      countries: [...countries],
    },
    must_haves: icp.mustHaves,
    disqualifiers: icp.disqualifiers,
  };
}

/**
 * Deletes the person's snapshots in the caller's tenant run, their verdicts first (the key's ON DELETE
 * CASCADE would take them too, uncounted), and the batch's attempts at them: this module's step of
 * the deletion script (alpha-p10-030). The rows deleted, by table.
 */
export async function erasePerson(
  id: string,
): Promise<
  Readonly<Record<"score_snapshots" | "criterion_verdicts" | "assessment_attempts", number>>
> {
  const { personId: person } = parse(z.object({ personId }), { personId: id });
  const where = { personId: person };
  const snapshots = await tenantClient.scoreSnapshot.findMany({ where, select: { id: true } });
  const snapshotId = { in: snapshots.map((snapshot) => snapshot.id) };
  const verdicts = await tenantClient.criterionVerdict.deleteMany({ where: { snapshotId } });
  const deleted = await tenantClient.scoreSnapshot.deleteMany({ where });
  const attempts = await tenantClient.assessmentAttempt.deleteMany({ where });
  return {
    score_snapshots: deleted.count,
    criterion_verdicts: verdicts.count,
    assessment_attempts: attempts.count,
  };
}

/** The model and the prompt version assessPerson calls with: the batch's idempotency key holds both. */
export async function assessmentModel(): Promise<{ modelId: string; promptVersion: number }> {
  const task = registeredTask();
  return { modelId: (await agentModel(task)).modelId, promptVersion: task.promptVersion };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/assess-fit). */
function registeredTask(): typeof assessFitTask {
  const task = registeredAgentTasks().get(ASSESS_FIT);
  if (task === undefined) throw new AppError(errors.assessment_agent_not_loaded);
  return task as unknown as typeof assessFitTask;
}

/** The input as the schema reads it, or qualification_input_invalid naming the fields, no value. */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
  throw new AppError(errors.qualification_input_invalid, { details: { fields } });
}
