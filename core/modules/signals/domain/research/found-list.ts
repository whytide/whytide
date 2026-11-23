// The Companies found list and Not a fit (README.md "Web research"; gamma-wr-110), in the caller's tenant
// run: the workspace's found companies with their reasons and how to reach them, filtered by source, by
// agent and by verdict, newest first, in pages by a cursor; and a member's mark, Not a fit, which moves a
// company to `not_fit` as the member's. The list opens on `fit` and `unsure`. A company whose source was
// deleted stays, under the label it was kept with. Nothing of a company goes to a log, a span or a metric.
import { personNames } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, canWriteOwned, currentTenant } from "@whytide/platform";
import { sourcesOf } from "@whytide/playbooks";
import { errors } from "../../errors.ts";
import { permissions } from "../../permissions.ts";
import {
  FOUND_LEADS_MAX,
  FOUND_PAGE_DEFAULT,
  FOUND_PAGE_MAX,
  LIST_DEFAULT_VERDICTS,
  MEMBER_MARK_NOT_FIT,
  type Verdict,
} from "./constants.ts";
import type { Reason } from "./verdict.ts";

/** What a request narrows the list by: a source, an agent (its sources) and a verdict; none is the default two. */
export type FoundFilter = {
  readonly sourceId?: string | undefined;
  readonly playbookId?: string | undefined;
  readonly verdict?: Verdict | undefined;
};

/** A lead found at a company: its person's id, name and title, as contacts keeps them. */
export type FoundLead = {
  readonly personId: string;
  readonly name: string | null;
  readonly title: string | null;
};

/** A found company as the routes answer it. */
export type FoundCompany = {
  readonly id: string;
  readonly sourceId: string | null;
  /** The source's label now, or the one the company was kept with once the source is gone. */
  readonly sourceLabel: string;
  readonly name: string;
  readonly domain: string;
  readonly website: string;
  readonly verdict: Verdict;
  /** Whether a member set the verdict (Not a fit), who, and when. */
  readonly markedByMember: boolean;
  readonly markedBy: string | null;
  readonly markedAt: Date | null;
  readonly reasons: readonly Reason[];
  readonly country: string | null;
  readonly town: string | null;
  readonly state: string | null;
  readonly pageUrl: string;
  readonly placeId: string | null;
  readonly email: string | null;
  readonly phones: readonly string[];
  readonly postalAddress: string | null;
  readonly judgedAt: Date;
  /** The leads found there (gamma-wr-060's research events), the first FOUND_LEADS_MAX, oldest first. */
  readonly leads: readonly FoundLead[];
  /** How many leads were found there, all of them. */
  readonly leadCount: number;
};

/** A page of the list: the companies, and the cursor of the next page, null on the last. */
export type FoundPage = { readonly companies: FoundCompany[]; readonly nextCursor: string | null };

const BAD_CURSOR = { details: { fields: ["cursor"] } };

/** The cursor of a page: the last company's judgment time and id, which order the list. */
const encodeCursor = (at: Date, id: string): string =>
  Buffer.from(`${at.getTime()}|${id}`).toString("base64url");

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [time, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(Number(time));
  if (id === undefined || id === "" || Number.isNaN(at.getTime())) {
    throw new AppError(errors.signal_config_invalid, BAD_CURSOR);
  }
  return { at, id };
}

/** The `where` of a filter, with the cursor's position when a later page is asked for. */
async function whereOf(filter: FoundFilter, after?: { at: Date; id: string }) {
  const sources: object[] = [];
  if (filter.sourceId !== undefined) sources.push({ sourceId: filter.sourceId });
  if (filter.playbookId !== undefined) {
    sources.push({ sourceId: { in: await sourcesOf(filter.playbookId) } });
  }
  const verdict = filter.verdict ?? { in: [...LIST_DEFAULT_VERDICTS] };
  const position =
    after === undefined
      ? []
      : [
          {
            OR: [{ judgedAt: { lt: after.at } }, { judgedAt: after.at, id: { lt: after.id } }],
          },
        ];
  return { AND: [...sources, { verdict }, ...position] };
}

type Row = Awaited<ReturnType<typeof findRows>>[number];

const findRows = async (where: object, take: number) =>
  tenantClient.signalFoundCompany.findMany({
    where,
    orderBy: [{ judgedAt: "desc" }, { id: "desc" }],
    take,
  });

/** The label of each of the rows' sources that still exists (the tenant client takes no relation). */
async function labelsOf(rows: readonly Row[]): Promise<ReadonlyMap<string, string>> {
  const sourceIds = [
    ...new Set(rows.flatMap(({ sourceId }) => (sourceId === null ? [] : [sourceId]))),
  ];
  if (sourceIds.length === 0) return new Map();
  const sources = await tenantClient.signalSource.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, label: true },
  });
  return new Map(sources.map(({ id, label }) => [id, label]));
}

/** The persons the research events name for each company, in the order the events were made. */
async function leadsOf(rows: readonly Row[]): Promise<ReadonlyMap<string, readonly string[]>> {
  if (rows.length === 0) return new Map();
  const events = await tenantClient.signalEvent.findMany({
    where: { foundCompanyId: { in: rows.map(({ id }) => id) } },
    select: { foundCompanyId: true, personId: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const byCompany = new Map<string, string[]>();
  for (const { foundCompanyId, personId } of events) {
    const held = byCompany.get(foundCompanyId ?? "") ?? [];
    if (!held.includes(personId)) byCompany.set(foundCompanyId ?? "", [...held, personId]);
  }
  return byCompany;
}

/** The leads of the companies as rows answer them: ids of a person erased are dropped from the names. */
async function withLeads(rows: readonly Row[], labels: ReadonlyMap<string, string>) {
  const found = await leadsOf(rows);
  const shown = [...found.values()].flatMap((ids) => ids.slice(0, FOUND_LEADS_MAX));
  const people = new Map((await personNames(shown)).map((person) => [person.id, person]));
  return rows.map((row) => {
    const ids = found.get(row.id) ?? [];
    const leads = ids.slice(0, FOUND_LEADS_MAX).flatMap((personId) => {
      const person = people.get(personId);
      if (person === undefined) return [];
      const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
      return [{ personId, name: name === "" ? null : name, title: person.title }];
    });
    return toCompany(row, labels, leads, ids.length);
  });
}

function toCompany(
  row: Row,
  labels: ReadonlyMap<string, string>,
  leads: readonly FoundLead[] = [],
  leadCount = leads.length,
): FoundCompany {
  const label = row.sourceId === null ? undefined : labels.get(row.sourceId);
  return {
    ...{ id: row.id, sourceId: row.sourceId, sourceLabel: label ?? row.sourceLabel },
    ...{ name: row.name, domain: row.domain, website: `https://${row.domain}/` },
    ...{ verdict: row.verdict, markedByMember: row.memberMark !== null },
    ...{ markedBy: row.memberMarkedBy, markedAt: row.memberMarkedAt },
    ...{ reasons: row.reasons as unknown as Reason[] },
    ...{ country: row.country, town: row.town, state: row.state },
    ...{ pageUrl: row.pageUrl, placeId: row.placeId, judgedAt: row.judgedAt },
    ...{ email: row.email, phones: row.phones, postalAddress: row.postalAddress },
    ...{ leads, leadCount },
  };
}

/**
 * A page of the workspace's found companies, newest judged first. `limit` is bounded by FOUND_PAGE_MAX;
 * `cursor` is the `nextCursor` of the page before, else `signal_config_invalid` naming `cursor`.
 */
export async function listFoundCompanies(
  filter: FoundFilter,
  options: { readonly limit?: number | undefined; readonly cursor?: string | undefined } = {},
): Promise<FoundPage> {
  const limit = Math.min(options.limit ?? FOUND_PAGE_DEFAULT, FOUND_PAGE_MAX);
  const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const rows = await findRows(await whereOf(filter, after), limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(last.judgedAt, last.id) : null;
  const labels = await labelsOf(page);
  return { companies: await withLeads(page, labels), nextCursor };
}

/**
 * Not a fit: the company is `not_fit`, marked as the member's with who and when, and it is never read or
 * judged again for its source, whatever its age (candidates.ts). Allowed to whoever may write the source,
 * its creator or a holder of signals.manage; a company whose source is gone, to signals.manage alone.
 * `signal_found_company_not_found` for a company of another workspace, `forbidden` before any write.
 * Marking one a member marked already changes nothing: the first mark's who and when stay.
 */
export async function markNotFit(id: string, now = new Date()): Promise<FoundCompany> {
  const row = await tenantClient.signalFoundCompany.findFirst({ where: { id } });
  if (row === null) throw new AppError(errors.signal_found_company_not_found);
  const source =
    row.sourceId === null
      ? null
      : await tenantClient.signalSource.findFirst({ where: { id: row.sourceId } });
  const { principal } = currentTenant();
  const owned = {
    ownerUserId: source?.createdBy ?? null,
    manageAction: permissions["signals.manage"],
  };
  const decision = canWriteOwned(principal, owned);
  if (decision !== "allow") throw new AppError(decision);
  const labels = await labelsOf([row]);
  if (row.memberMark !== null) return (await withLeads([row], labels))[0] as FoundCompany;
  const marked = await tenantClient.signalFoundCompany.update({
    where: { id: row.id },
    data: {
      ...{ verdict: "not_fit" as const, memberMark: MEMBER_MARK_NOT_FIT },
      ...{ memberMarkedBy: principal.userId, memberMarkedAt: now },
    },
  });
  return (await withLeads([marked], labels))[0] as FoundCompany;
}
