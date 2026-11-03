// A lead's cost (README "The cost counter"; docs/concepts.md "Costs"), for GET …/credits/leads/
// {personId}/cost, in the caller's tenant run: the credits committed with the person as subject (its
// assessments), what the vendors cost for the calls about it (assessments, drafts), and its share of
// what each signal run that found it read: the credits the run committed for its engagers read, over
// the candidates it staged, once per candidate of the person's. By module, an action's first part or
// a cost event's feature. A person with no lead in the workspace, one of another workspace included,
// is contacts' lead_not_found.
import { getLead } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { type PersonRead, personReads, prices } from "@whytide/signals";
import { share, sum } from "./decimal.ts";

export type LeadCost = {
  readonly personId: string;
  readonly credits: string;
  readonly money: string;
  readonly byFeature: { feature: string; credits: string; money: string }[];
};

const READ = prices["signals.engager_read"];
const moduleOf = (action: string): string => action.split(".")[0] ?? action;

/** The person's share of its runs' reads: each run's credits × the person's candidates ÷ the run's. */
export function readShare(
  reads: readonly PersonRead[],
  runCredits: ReadonlyMap<string, string>,
): string {
  return sum(
    reads.map(({ runId, candidates, personCandidates }) =>
      share(runCredits.get(runId) ?? "0", personCandidates, candidates),
    ),
  );
}

export async function leadCost(personId: string): Promise<LeadCost> {
  await getLead(personId);
  const usage = await tenantClient.creditUsage.groupBy({
    by: ["action"],
    where: { subjectRef: personId, status: "committed" },
    _sum: { credits: true },
  });
  const calls = await tenantClient.costEvent.groupBy({
    by: ["feature"],
    where: { subjectRef: personId },
    _sum: { unitCost: true },
  });
  const reads = await personReads(personId);
  const parts = new Map<string, { credits: string[]; money: string[] }>();
  const add = (feature: string, kind: "credits" | "money", amount: string) => {
    const part = parts.get(feature) ?? { credits: [], money: [] };
    part[kind].push(amount);
    parts.set(feature, part);
  };
  for (const { action, _sum } of usage)
    add(moduleOf(action), "credits", _sum.credits?.toFixed() ?? "0");
  for (const { feature, _sum } of calls) add(feature, "money", _sum.unitCost?.toFixed() ?? "0");
  if (reads.length > 0) {
    const runs = await tenantClient.creditUsage.groupBy({
      by: ["subjectRef"],
      where: {
        subjectRef: { in: reads.map(({ runId }) => runId) },
        action: READ,
        status: "committed",
      },
      _sum: { credits: true },
    });
    const runCredits = new Map(
      runs.map(({ subjectRef, _sum }) => [subjectRef, _sum.credits?.toFixed() ?? "0"]),
    );
    add(moduleOf(READ), "credits", readShare(reads, runCredits));
  }
  const byFeature = [...parts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([feature, part]) => ({ feature, credits: sum(part.credits), money: sum(part.money) }));
  const credits = sum(byFeature.map((part) => part.credits));
  return { personId, credits, money: sum(byFeature.map((part) => part.money)), byFeature };
}
