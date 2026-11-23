// The golden set (README.md "The golden set"): a line per reviewed lead of the workspace, or of one
// ISO week (golden-line.ts), written through the files port under the workspace's exports/ and given
// back. The reviews are read in one run, the lines a hundred leads a run, and the file is written
// outside any. Nothing here logs: the lines hold the profile's anonymized words and the testers' texts.
import { rawPrompts } from "@whytide/ai";
import { getCompany, getPerson, type LatestReview, latestReviews } from "@whytide/contacts";
import { tenantClient, withTenant } from "@whytide/db";
import { type Icp, readIcpForScoring } from "@whytide/icp";
import { currentTenant, type TenantContext } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import type { AssessFitInput } from "../../schemas/assess-fit.ts";
import { assessmentInput } from "../assess/assess-person.ts";
import { givenClient } from "../client.ts";
import { type GoldenLine, type GoldenSnapshot, goldenLine, inputOfPrompt } from "./golden-line.ts";

/** JSON Lines: a JSON object a line, UTF-8. */
export const JSONL = "application/jsonl; charset=utf-8";
const PAGE = 100;

export type GoldenSetFile = {
  /** The whole key, `w/<workspaceId>/exports/golden-set-<date>.jsonl`. */
  readonly key: string;
  readonly lines: number;
  readonly body: string;
};

/**
 * The workspace's golden set, every reviewed lead or, with `week`, those whose latest decision falls
 * in it, written to `exports/golden-set-<date>.jsonl` (UTC; a second export that day replaces it).
 * contacts_input_invalid for a week the year does not have; files_too_large past 25 MiB.
 */
export async function exportGoldenSet(
  tenant: TenantContext,
  view: { week?: string },
): Promise<GoldenSetFile> {
  const inRun = <T>(fn: () => Promise<T>) => withTenant(tenant, fn, { client: givenClient() });
  const reviews = await inRun(() => latestReviews(view));
  const chunks: string[] = [];
  for (let at = 0; at < reviews.length; at += PAGE) {
    const lines = await inRun(() => goldenLines(reviews.slice(at, at + PAGE)));
    chunks.push(...lines.map((line) => `${JSON.stringify(line)}\n`));
  }
  const body = chunks.join("");
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const key = `exports/golden-set-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const { workspaceId } = tenant;
  const stored = await files.put({ workspaceId, key, body, contentType: JSONL });
  return { key: stored.key, lines: reviews.length, body };
}

/**
 * The lines of the reviewed leads given, in their order, in the caller's tenant run. The input is the
 * one the decision record keeps until its raw_purge_after; after it, or for a lead decided before an
 * assessment, it is rebuilt from the person, the company and the ICP as they are now, no evidence.
 */
export async function goldenLines(reviews: readonly LatestReview[]): Promise<GoldenLine[]> {
  const snapshots = await snapshotsOf(reviews.flatMap(({ snapshotId }) => snapshotId ?? []));
  const prompts = await rawPrompts([...snapshots.values()].map((s) => s.decisionRecordId));
  const icps = new Map<string, Icp>();
  const lines: GoldenLine[] = [];
  for (const review of reviews) {
    const snapshot = review.snapshotId === null ? null : (snapshots.get(review.snapshotId) ?? null);
    const prompt = snapshot === null ? null : (prompts.get(snapshot.decisionRecordId) ?? null);
    const kept = prompt === null ? null : inputOfPrompt(prompt);
    if (kept !== null) {
      lines.push(goldenLine({ review, snapshot, input: { from: "decision_record", value: kept } }));
      continue;
    }
    // The audience the snapshot was assessed against, read once each; none, the default.
    const icpId = snapshot?.icpId ?? undefined;
    const icp =
      icps.get(icpId ?? "") ?? (await readIcpForScoring(currentTenant().workspaceId, icpId)).icp;
    icps.set(icpId ?? "", icp);
    const value = await rebuilt(review.personId, icp);
    lines.push(goldenLine({ review, snapshot, input: { from: "rebuilt", value } }));
  }
  return lines;
}

async function rebuilt(personId: string, icp: Icp): Promise<AssessFitInput> {
  const person = await getPerson(personId);
  const company = person.companyId === null ? null : await getCompany(person.companyId);
  return assessmentInput(person, company, icp);
}

/** A snapshot with its decision record and its audience (gamma-p5-050), which no line holds. */
type Stored = GoldenSnapshot & {
  readonly decisionRecordId: string;
  readonly icpId: string | null;
};

/**
 * The snapshots named, with the model's verdicts, by id: a member's verdict is no eval data (README
 * "A member's verdict"), so a row a member wrote alone is left out.
 */
async function snapshotsOf(ids: readonly string[]): Promise<Map<string, Stored>> {
  if (ids.length === 0) return new Map();
  const where = { id: { in: [...ids] } };
  const rows = await tenantClient.scoreSnapshot.findMany({ where });
  const verdicts = await tenantClient.criterionVerdict.findMany({
    where: { snapshotId: { in: [...ids] } },
    select: { snapshotId: true, criterion: true, verdict: true, evidence: true },
  });
  return new Map(
    rows.map((row) => {
      const { id, modelId, promptVersion, status, fitScore, tier, disqualifiers } = row;
      const own = verdicts.flatMap(({ snapshotId, criterion, verdict, evidence }) =>
        snapshotId === id && verdict !== null ? [{ criterion, verdict, evidence }] : [],
      );
      const snapshot = { modelId, promptVersion, status, fitScore, tier, disqualifiers };
      const { decisionRecordId, icpId } = row;
      return [id, { ...snapshot, decisionRecordId, icpId, verdicts: own }];
    }),
  );
}
