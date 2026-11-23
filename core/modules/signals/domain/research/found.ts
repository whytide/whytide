// The found company (README.md "Web research"; docs/data.md; gamma-wr-050): what a research run keeps
// of a company it judged, in one tenant run. The company goes to contacts through `upsertCompany`, with
// its name, its website and its country, stamped as read from its website (the class `website`, the
// provider `website`) so that enrichment does not ask for them again; a business of one person is passed
// as one (a headcount of 1), so that contacts keeps its facts on the workspace's row only, and such a
// business keeps no general address, phone or postal address. The row is one for each source and
// domain: a company met again after SIGNALS_RESEARCH_RECHECK_DAYS is judged again and its facts, reasons
// and verdict replaced, a member's own mark kept, and with it the verdict it gave. The candidate is read, the run's counts grow. All of it
// is one run of the workspace, so a step run again finds the candidate read and adds nothing twice.
// It holds no person: no id and no name of one.
import { upsertCompany } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { isAppError, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { addCounts, type RunRef } from "../runs.ts";
import {
  COUNT_COMPANIES_JUDGED,
  countJudgeRefused,
  countVerdict,
  JUDGE_GATES,
  MEMBER_MARK_NOT_FIT,
  type Verdict,
} from "./constants.ts";
import type { JudgeStep } from "./judge.ts";
import type { Reason } from "./verdict.ts";

/** The class and the provider contacts stamps a company's facts read from its site with. */
export const SITE_STAMP = { source: "website", provider: "website" } as const;
/** What a company's own contacts call refuses for a domain that is none: the row is kept with no company. */
const NO_COMPANY = new Set(["contacts_input_invalid", "linkedin_url_invalid"]);

/** What a judgment keeps, after the gates: the verdict, the reasons, where the company is, how it is reached. */
export type Verdicted = {
  readonly verdict: Verdict;
  readonly reasons: readonly Reason[];
  /** What each gate refused, by gate. */
  readonly refused: Readonly<Record<string, number>>;
  readonly readAt: string;
  readonly onePerson: boolean;
  readonly country: string | null;
  readonly town: string | null;
  readonly state: string | null;
  readonly email: string | null;
  readonly phones: readonly string[];
  readonly postal: string | null;
};

/**
 * The candidate kept as a found company, in the caller's run of the workspace: `judged` with its verdict,
 * `skipped` for a candidate that is not pending (an earlier attempt kept it: its verdict is the row's) or
 * gone, `gone` for a source gone.
 */
export async function keepFoundCompany(
  { workspaceId, sourceId, runId }: RunRef,
  candidateId: string,
  judged: Verdicted,
): Promise<JudgeStep> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return { status: "gone" };
  const candidate = await tenantClient.signalResearchCandidate.findFirst({
    where: { id: candidateId },
  });
  if (candidate === null) return { status: "skipped" };
  const readAt = new Date(judged.readAt);
  const taken = await tenantClient.signalResearchCandidate.updateMany({
    where: { id: candidateId, state: "pending" },
    data: { state: "read", stateAt: readAt },
  });
  if (taken.count === 0) {
    // An earlier attempt kept it.
    const row = await tenantClient.signalFoundCompany.findFirst({
      where: { sourceId, domain: candidate.domain, runId },
    });
    return row === null ? { status: "skipped" } : { status: "judged", verdict: row.verdict };
  }
  const companyId = await keepCompany(candidate, judged, readAt);
  const reached = judged.onePerson
    ? { email: null, phones: [] as string[], postalAddress: null }
    : { email: judged.email, phones: [...judged.phones], postalAddress: judged.postal };
  const row = await tenantClient.signalFoundCompany.findFirst({
    where: { sourceId, domain: candidate.domain },
  });
  // A member's mark is theirs (gamma-wr-110): the run never replaces the verdict Not a fit gave.
  const verdict = row?.memberMark === MEMBER_MARK_NOT_FIT ? row.verdict : judged.verdict;
  const data = {
    ...{
      runId,
      name: candidate.name,
      verdict,
      reasons: judged.reasons as object[],
    },
    ...{ country: judged.country, town: judged.town, state: judged.state },
    ...{ onePerson: judged.onePerson, ...reached, companyId },
    ...{ pageUrl: candidate.pageUrl, placeId: candidate.placeId, sourceLabel: source.label },
    judgedAt: readAt,
  };
  if (row === null) {
    const id = newId(ids.signal_found_company);
    await tenantClient.signalFoundCompany.create({
      data: { id, workspaceId, sourceId, domain: candidate.domain, ...data },
    });
  } else await tenantClient.signalFoundCompany.update({ where: { id: row.id }, data });
  const counts: Record<string, number> = {
    [COUNT_COMPANIES_JUDGED]: 1,
    [countVerdict(verdict)]: 1,
  };
  for (const gate of JUDGE_GATES) counts[countJudgeRefused(gate)] = judged.refused[gate] ?? 0;
  await addCounts(runId, counts);
  return { status: "judged", verdict };
}

/** The company in contacts: its name, website and country, stamped as read from its site; null when contacts takes none. */
async function keepCompany(
  candidate: { readonly name: string; readonly domain: string },
  judged: Verdicted,
  readAt: Date,
): Promise<string | null> {
  const company = {
    ...{ name: candidate.name, domain: candidate.domain, fetchedAt: readAt },
    ...(judged.country === null ? {} : { country: judged.country }),
    ...(judged.onePerson ? { employeeCount: 1 } : {}),
  };
  try {
    const { company: stored } = await upsertCompany({ ...SITE_STAMP, company });
    return stored.id;
  } catch (error) {
    if (!isAppError(error) || !NO_COMPANY.has(error.code)) throw error;
    return null;
  }
}
