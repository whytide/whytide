// What a source's earlier runs found, for the plan to read (README.md "Web research"; gamma-wr-051): how
// many companies each query and each source type led to, by verdict, and the towns and states of the
// fitting ones, so that a later run looks where little was found. Counts, source type ids, query ids
// and place words only: never a company's name, its site, a line or a quote. Read in a tenant run.
import { tenantClient } from "@whytide/db";
import type { Verdict } from "./constants.ts";
import { FOUND_ROWS_MAX, FOUND_TOWNS_MAX } from "./constants.ts";

/** The companies of one group, by verdict. */
export type VerdictCounts = { fit: number; notFit: number; unsure: number };

/** A place the fitting companies are in, with how many. */
export type FoundTown = {
  readonly country: string | null;
  readonly town: string;
  readonly state: string | null;
  readonly companies: number;
};

export type FoundStats = {
  /** By the query whose results led to the company's page. */
  readonly byQuery: ReadonlyMap<string, VerdictCounts>;
  /** By the source type of the search that found its page. */
  readonly byPlace: ReadonlyMap<string, VerdictCounts>;
  /** The most common first, at most FOUND_TOWNS_MAX. */
  readonly towns: readonly FoundTown[];
};

const none = (): VerdictCounts => ({ fit: 0, notFit: 0, unsure: 0 });
const KEY: Record<Verdict, keyof VerdictCounts> = {
  fit: "fit",
  not_fit: "notFit",
  unsure: "unsure",
};

function add(map: Map<string, VerdictCounts>, key: string, verdict: Verdict): void {
  const counts = map.get(key) ?? none();
  counts[KEY[verdict]] += 1;
  map.set(key, counts);
}

/**
 * The source's found companies (the newest FOUND_ROWS_MAX), counted by query, by source type and by
 * verdict, with the towns and states of the fitting ones. A company whose page came from a start page, or
 * from a run before the queries were kept with it, counts under no query.
 */
export async function foundStats(sourceId: string): Promise<FoundStats> {
  const found = await tenantClient.signalFoundCompany.findMany({
    where: { sourceId },
    select: { domain: true, verdict: true, placeId: true, country: true, town: true, state: true },
    orderBy: [{ judgedAt: "desc" }, { id: "desc" }],
    take: FOUND_ROWS_MAX,
  });
  const candidates = await tenantClient.signalResearchCandidate.findMany({
    where: { sourceId, domain: { in: found.map(({ domain }) => domain) }, queryId: { not: null } },
    select: { domain: true, queryId: true },
  });
  const queryOf = new Map(candidates.map(({ domain, queryId }) => [domain, queryId]));
  const byQuery = new Map<string, VerdictCounts>();
  const byPlace = new Map<string, VerdictCounts>();
  const towns = new Map<string, FoundTown>();
  for (const row of found) {
    const queryId = queryOf.get(row.domain);
    if (queryId !== undefined && queryId !== null) add(byQuery, queryId, row.verdict);
    if (row.placeId !== null) add(byPlace, row.placeId, row.verdict);
    if (row.verdict !== "fit" || row.town === null) continue;
    const key = `${row.country ?? ""}|${row.town}|${row.state ?? ""}`;
    const held = towns.get(key);
    towns.set(key, {
      ...{ country: row.country, town: row.town, state: row.state },
      companies: (held?.companies ?? 0) + 1,
    });
  }
  const ranked = [...towns.values()].sort(
    (a, b) => b.companies - a.companies || a.town.localeCompare(b.town),
  );
  return { byQuery, byPlace, towns: ranked.slice(0, FOUND_TOWNS_MAX) };
}
