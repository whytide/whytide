// What a member marked Not a fit, for the run and the plan (README.md "Web research"; gamma-wr-110), in
// the caller's tenant run. A company marked is never read or judged again for its source, whatever its
// age, so the run's candidate steps ask for the marked domains before they decide anything; and the plan
// is told the source's own Not a fit companies, so that a later run looks elsewhere.
import { tenantClient } from "@whytide/db";
import { MEMBER_MARK_NOT_FIT, NOT_FIT_IN_INPUT_MAX } from "./constants.ts";

/** Which of the domains the source's member marked Not a fit. */
export async function notFitDomains(
  sourceId: string,
  domains: readonly string[],
): Promise<ReadonlySet<string>> {
  if (domains.length === 0) return new Set();
  const rows = await tenantClient.signalFoundCompany.findMany({
    where: { sourceId, memberMark: MEMBER_MARK_NOT_FIT, domain: { in: [...domains] } },
    select: { domain: true },
  });
  return new Set(rows.map(({ domain }) => domain));
}

/** A company a member marked Not a fit, as the plan reads it: its name, its site's host and where it is. */
export type NotFitCompany = {
  readonly name: string;
  readonly domain: string;
  readonly country: string | null;
  readonly town: string | null;
};

/** The source's own Not a fit companies, the newest mark first, at most NOT_FIT_IN_INPUT_MAX. */
export async function notFitOf(sourceId: string): Promise<NotFitCompany[]> {
  return tenantClient.signalFoundCompany.findMany({
    where: { sourceId, memberMark: MEMBER_MARK_NOT_FIT },
    select: { name: true, domain: true, country: true, town: true },
    orderBy: [{ memberMarkedAt: "desc" }, { id: "desc" }],
    take: NOT_FIT_IN_INPUT_MAX,
  });
}
