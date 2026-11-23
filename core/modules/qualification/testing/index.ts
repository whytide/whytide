// qualification's test helpers (README.md "Testing"), `@whytide/qualification/testing`, in test files
// only: useQualificationClient(asRole("app")) points the batch's own reads, the tick's workspaces and
// callAgent's runs, at the test's schema; undefined puts the process's client back. createScoreSnapshot
// writes a scored snapshot on asRole("app") of @whytide/db/testing, after withTestDb(), or on the
// client given. useSignalReader puts a fake signal reader in place (README "Intent and priority");
// setLeadPriority writes a person's intent row with a priority and its tier, in the caller's tenant
// run, for other modules' tests.
import type { PrismaClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { ids } from "../ids.ts";

export { useClient as useQualificationClient } from "../domain/client.ts";
export { setLeadPriority } from "../domain/intent/store.ts";
export { useSignalReader } from "../domain/signal-reader.ts";

/**
 * A scored snapshot of the person, as an assessment leaves its own, with no verdicts: `criteriaHash`
 * empty unless given (a re-score's copy), `createdAt` now unless given.
 */
export async function createScoreSnapshot(
  input: {
    workspaceId: string;
    personId: string;
    status: "qualified" | "not_qualified" | "needs_review";
    createdAt?: Date;
    criteriaHash?: string;
  },
  client: PrismaClient = asRole("app"),
): Promise<{ id: string; createdAt: Date }> {
  const id = newId(ids.score_snapshot);
  const model = { modelId: "fake-model", promptVersion: 1, scorerVersion: "fit-v1" };
  const scored = { icpVersion: 1, fitScore: 80, summary: "", decisionRecordId: `dr_${id}` };
  return client.scoreSnapshot.create({ data: { ...input, ...model, ...scored, id } });
}
