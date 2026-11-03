// The leads the assessments of a span qualified, for credits' cost counter (alpha-p10-010; README
// "Public interface"): the persons with an assessment's own snapshot (no re-score's criteria hash)
// created in [from, to) and scored `qualified`, each once. A re-score's copy costs nothing, and its
// lead was counted at its assessment. In the caller's tenant run.
import { tenantClient } from "@whytide/db";

export async function countQualified(span: { from: Date; to: Date }): Promise<number> {
  const createdAt = { gte: span.from, lt: span.to };
  const persons = await tenantClient.scoreSnapshot.groupBy({
    by: ["personId"],
    where: { status: "qualified", criteriaHash: "", createdAt },
  });
  return persons.length;
}
