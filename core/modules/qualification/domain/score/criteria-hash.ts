// The criteria a snapshot is scored with, hashed (docs/data.md `criteria_hash`): scoreSnapshot stores
// the hash that scored a snapshot, and the re-score (../rescore.ts) keys its copies with it.
import { createHash } from "node:crypto";
import type { ScoringCriterion } from "./index.ts";

/** Each criterion's key, weight, must and enabled, by key: the same criteria give the same hash. */
export function criteriaHash(criteria: readonly ScoringCriterion[]): string {
  const sorted = [...criteria].sort((a, b) => (a.key < b.key ? -1 : 1));
  const rows = sorted.map(({ key, weight, isMust, enabled }) => [key, weight, isMust, enabled]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
