// The people on the pages of the companies a research run judged `fit` (README.md "Web research";
// docs/flows.md; gamma-wr-060). The queue (signals_research_people_queue) lines up the source's found
// companies that are `fit` and whose people were not taken, oldest first, at most the companies' limit,
// as ids in a file. The step (signals_research_people), one company a step by its place in the queue,
// reads the company's pages (people-pages.ts), has the agent signals.research-read-people say who they
// name with a role (extraction), gates the answer in code (people-checks.ts), has the agent
// signals.research-pick-people choose among them on the roles alone (rule 35) and makes the picked
// people with a key the page printed (people-make.ts); the pick's first SIGNALS_RESEARCH_PEOPLE_PER_COMPANY
// are taken. The read, the pick and the making of one company's people are inside this one step, and
// the step answers a status: no name, role, link or address is in its input, its result, a log line, a
// span, a metric or the workflow's history, and a person not made leaves no row anywhere. The company's
// `people_taken_at` is set in the same tenant run that makes its people, so that a step run again
// finds it set and adds nothing, and a run cut short takes the company up at the next run; a read or a
// pick the model fails twice leaves it unset, so that a later run asks again. A later read of a
// company adds no person. gamma-wr-090: a company whose pages gave fewer picked people than the limit
// gets one more look, a web search for its managers (managers.ts), whose people the same pick judges on
// their roles for the places left. The two calls' decision records have the workspace as their subject, so that
// the deletion of any person removes them, as the triage's (evidence.ts erasePerson).
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { findPersonsByNameAtCompany } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, isAppError, publish } from "@whytide/platform";
import type { researchPickPeopleTask } from "../../agents/research-pick-people/task.ts";
import type { researchReadPeopleTask } from "../../agents/research-read-people/task.ts";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { RESEARCH_PICK_PEOPLE } from "../../schemas/research-pick-people.ts";
import { RESEARCH_READ_PEOPLE } from "../../schemas/research-read-people.ts";
import { settings } from "../../settings.ts";
import { sourceKind } from "../../sources/registry.ts";
import { audienceOf } from "../agents.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import {
  COUNT_PEOPLE_AMBIGUOUS,
  COUNT_PEOPLE_COMPANIES,
  COUNT_PEOPLE_CONFLICT,
  COUNT_PEOPLE_ERASED,
  COUNT_PEOPLE_FOUND,
  COUNT_PEOPLE_KNOWN,
  COUNT_PEOPLE_LOOKUPS,
  COUNT_PEOPLE_NO_KEY,
  COUNT_PEOPLE_NO_PAGES,
  COUNT_PEOPLE_PHONES,
  COUNT_PEOPLE_PHONES_NOT_KEPT,
  COUNT_PEOPLE_PICKED,
  COUNT_PEOPLE_PICKS_FAILED,
  COUNT_PEOPLE_PROFILES,
  COUNT_PEOPLE_READ,
  COUNT_PEOPLE_READS_FAILED,
  countPeopleRefused,
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  PEOPLE_GATES,
} from "./constants.ts";
import { peopleQueueKey, readJsonFile } from "./files.ts";
import { takeManagers } from "./managers.ts";
import { type RoleWords, roleWordsOf } from "./managers-checks.ts";
import {
  chosenOf,
  type GatedPeople,
  type GatedPerson,
  gatePeople,
  pickInputOf,
} from "./people-checks.ts";
import { makePerson, type PersonOutcome, type PickedPerson } from "./people-make.ts";
import { addressesByName } from "./people-name.ts";
import { type PeopleWhere, peoplePagesOf } from "./people-pages.ts";
import { searchProfile } from "./people-profile.ts";
import { clean } from "./text.ts";

/** How the queue step ended: the companies lined up, or the source gone. */
export type PeopleQueued =
  | { readonly status: "queued"; readonly companies: number }
  | { readonly status: "gone" };

/** The queue's file: the found companies' ids, in the order their people are taken. */
type PeopleQueue = { readonly companies: readonly string[] };

/** What a company with no page to read gave: nobody, nothing refused. */
const NO_PEOPLE: GatedPeople = { people: [], refused: {} };

/**
 * How a people step ended: `taken` when the look ran to its end (the company's `people_taken_at` is set,
 * with `found` new leads), `failed` when the model could not answer (a later run asks again), `skipped`
 * for a company not in the queue, not `fit` any more or already taken, `gone` for a source gone.
 */
export type PeopleStep =
  | { readonly status: "taken"; readonly found: number }
  | { readonly status: "failed" | "skipped" | "gone" };

/**
 * The run's queue: the source's found companies judged `fit` whose people were not taken, the oldest
 * judged first, at most SIGNALS_RESEARCH_COMPANIES_PER_RUN. A step run again answers from the file.
 */
export async function queuePeople(ref: RunRef, tenant: TenantRun): Promise<PeopleQueued> {
  const { workspaceId, runId, sourceId } = ref;
  const filed = (await readJsonFile(workspaceId, peopleQueueKey(runId))) as PeopleQueue | null;
  if (filed !== null) return { status: "queued", companies: filed.companies.length };
  const found = await tenant(async () => {
    const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
    if (source === null) return null;
    return tenantClient.signalFoundCompany.findMany({
      where: { sourceId, verdict: "fit", peopleTakenAt: null },
      select: { id: true },
      orderBy: [{ judgedAt: "asc" }, { id: "asc" }],
      take: settings.SIGNALS_RESEARCH_COMPANIES_PER_RUN,
    });
  });
  if (found === null) return { status: "gone" };
  const companies = found.map(({ id }) => id);
  await writeRunFile(workspaceId, peopleQueueKey(runId), { companies });
  return { status: "queued", companies: companies.length };
}

/** What the step reads of the company, the source and the audience before the model is asked. */
type Read = {
  readonly where: PeopleWhere;
  readonly company: {
    readonly foundCompanyId: string;
    readonly name: string;
    readonly companyId: string | null;
    readonly country: string | null;
    /** The company's own lines the judge found: none of them is a person's. */
    readonly phones: readonly string[];
  };
  readonly sourceLabel: string;
  readonly eventKind: string;
  readonly audience: { readonly titles: string[]; readonly seniorities: string[] };
  /** The run's plan's role words by language (gamma-wr-090); none for a plan of an earlier version. */
  readonly roleWords: RoleWords;
  /** The language of the query that led to the company, for the role words asked first; null for none. */
  readonly language: string | null;
};

/**
 * The people of the queue's `index`th company (from 1). An llm_* code throws, for the activity's
 * attempts; a call over its budget or failed twice is `failed`.
 */
export async function takePeople(
  ref: RunRef,
  index: number,
  tenant: TenantRun,
  now = new Date(),
): Promise<PeopleStep> {
  const { workspaceId, runId } = ref;
  const queue = (await readJsonFile(workspaceId, peopleQueueKey(runId))) as PeopleQueue | null;
  const foundCompanyId = queue?.companies[index - 1];
  if (foundCompanyId === undefined) return { status: "skipped" };
  const read = await tenant(() => readCompany(ref, foundCompanyId));
  if (read === "gone") return { status: "gone" };
  if (read === "skipped") return { status: "skipped" };
  const pages = await peoplePagesOf(read.where);
  const managing = read.roleWords.length > 0;
  if (pages.length === 0 && !managing) {
    // Nothing to read: the look has run to its end, and a later run does not look again.
    await tenant(() => settle(ref, read, { [COUNT_PEOPLE_NO_PAGES]: 1 }, now));
    return { status: "taken", found: 0 };
  }
  const people = pages.length === 0 ? NO_PEOPLE : await readPeople(ref, read, pages);
  if (people === null) {
    await tenant(() => addCounts(runId, { [COUNT_PEOPLE_READS_FAILED]: 1 }));
    return { status: "failed" };
  }
  const refused: Record<string, number> = {};
  for (const gate of PEOPLE_GATES) refused[countPeopleRefused(gate)] = people.refused[gate] ?? 0;
  const counts: Record<string, number> = {
    ...refused,
    [COUNT_PEOPLE_READ]: people.people.length,
    ...(pages.length === 0 ? { [COUNT_PEOPLE_NO_PAGES]: 1 } : {}),
  };
  const cap = settings.SIGNALS_RESEARCH_PEOPLE_PER_COMPANY;
  const picked = await pickPeople(ref, read, people.people, cap);
  if (picked === null) {
    await tenant(() => addCounts(runId, { ...counts, [COUNT_PEOPLE_PICKS_FAILED]: 1 }));
    return { status: "failed" };
  }
  // The managers by search fill the places the pages left, picked on their roles by the same pick.
  const searched = await pickManagers(ref, read, people.people, picked.length, tenant);
  if (searched === null) {
    await tenant(() => addCounts(runId, { ...counts, [COUNT_PEOPLE_PICKS_FAILED]: 1 }));
    return { status: "failed" };
  }
  Object.assign(counts, searched.counts);
  const chosen: PickedPerson[] = [...picked, ...searched.people];
  const keyed = await profilesBySearch(ref, read, chosen, tenant);
  const addresses = new Map(pages.map(({ n, address }) => [n, address]));
  const context = {
    ...{ workspaceId, sourceId: ref.sourceId, runId, sourceLabel: read.sourceLabel },
    ...{ eventKind: read.eventKind, company: read.company, pages: addresses, now },
  };
  // The last step of a person's key (gamma-wr-080): a work address looked up for the name, the person
  // made inside it. Those made are counted and announced there; the step's own run skips them.
  const named = await addressesByName({
    ...{ ref, context, tenant, people: keyed.people, unknown: keyed.unknown },
    ...{ foundCompanyId, domain: read.where.domain },
  });
  return tenant(async () => {
    const still = await tenantClient.signalFoundCompany.findFirst({
      where: { id: foundCompanyId },
      select: { peopleTakenAt: true },
    });
    if (still === null || still.peopleTakenAt !== null) return { status: "skipped" as const };
    const tally: Record<string, number> = { ...counts, [COUNT_PEOPLE_PICKED]: chosen.length };
    if (keyed.profiles > 0) tally[COUNT_PEOPLE_PROFILES] = keyed.profiles;
    const found: string[] = [];
    for (const [index, person] of keyed.people.entries()) {
      if (named.has(index)) continue;
      const made: PersonOutcome = await makePerson(context, person);
      const name = OUTCOME_COUNT[made.outcome];
      tally[name] = (tally[name] ?? 0) + 1;
      if (made.outcome === "found") found.push(made.personId);
      if (made.outcome === "found" && made.lookup) {
        tally[COUNT_PEOPLE_LOOKUPS] = (tally[COUNT_PEOPLE_LOOKUPS] ?? 0) + 1;
      }
      if ("phone" in made && made.phone !== undefined) {
        const kept = made.phone === "kept" || made.phone === "known";
        const phoneCount = kept ? COUNT_PEOPLE_PHONES : COUNT_PEOPLE_PHONES_NOT_KEPT;
        tally[phoneCount] = (tally[phoneCount] ?? 0) + 1;
      }
    }
    if (found.length > 0) {
      const outbox = outboxWriter(tenantClient, workspaceId);
      await publish(outbox, events["signals.person_found"], { workspaceId, personIds: found });
    }
    await settle(ref, read, tally, now);
    return { status: "taken" as const, found: found.length + named.size };
  });
}

/**
 * The picked people, each with no key the page printed (no profile, no address) and unknown to the
 * workspace given their profile by one search (people-profile.ts): the search is asked before the
 * step's own tenant run, since it is an outside call, one at a time, in the pick's order, and ends
 * for the rest at the run's searches' limit or when every adapter is spent. A person the workspace
 * holds at the company already (a match by name, one or more) is not searched for. `profiles`: how
 * many were found. `unknown`: the names the workspace holds no person of at the company.
 */
async function profilesBySearch(
  ref: RunRef,
  read: Read,
  picked: readonly GatedPerson[],
  tenant: TenantRun,
): Promise<{ people: PickedPerson[]; profiles: number; unknown: Set<string> }> {
  const { companyId, name: companyName, country, foundCompanyId } = read.company;
  const keyless = picked.filter(({ profile, email }) => profile === null && email === null);
  const unknown = new Set<string>();
  if (keyless.length > 0) {
    await tenant(async () => {
      for (const { name } of keyless) {
        const matches = await findPersonsByNameAtCompany({
          ...{ name, companyName },
          ...(companyId === null ? {} : { companyId }),
        });
        if (matches.length === 0) unknown.add(name);
      }
    });
  }
  let profiles = 0;
  let stopped = false;
  const people: PickedPerson[] = [];
  for (const [index, person] of picked.entries()) {
    if (stopped || !unknown.has(person.name) || person.profile !== null || person.email !== null) {
      people.push(person);
      continue;
    }
    const ask = { foundCompanyId, n: index + 1, name: person.name, companyName, country };
    const answer = await searchProfile(ref, ask, tenant);
    if (answer.stop === true) stopped = true;
    if (answer.profile === null) {
      people.push(person);
      continue;
    }
    profiles += 1;
    people.push({ ...person, profile: answer.profile, bySearch: true });
  }
  return { people, profiles, unknown };
}

/** The count each person's outcome adds. */
const OUTCOME_COUNT: Record<PersonOutcome["outcome"], string> = {
  found: COUNT_PEOPLE_FOUND,
  known: COUNT_PEOPLE_KNOWN,
  no_key: COUNT_PEOPLE_NO_KEY,
  ambiguous: COUNT_PEOPLE_AMBIGUOUS,
  conflict: COUNT_PEOPLE_CONFLICT,
  erased: COUNT_PEOPLE_ERASED,
};

/** The company's people marked taken and the counts added, in the caller's tenant run. */
async function settle(
  { runId }: RunRef,
  { company }: Read,
  counts: Readonly<Record<string, number>>,
  now: Date,
): Promise<void> {
  await tenantClient.signalFoundCompany.updateMany({
    where: { id: company.foundCompanyId, peopleTakenAt: null },
    data: { peopleTakenAt: now },
  });
  await addCounts(runId, { ...counts, [COUNT_PEOPLE_COMPANIES]: 1 });
}

/**
 * The company, its source and its audience, in the caller's tenant run: `gone` for a source gone,
 * `skipped` for a company that is not `fit` any more (a member's mark does not matter) or whose people
 * were taken already, as an earlier attempt's tenant run commits them with the mark.
 */
async function readCompany(
  ref: RunRef,
  foundCompanyId: string,
): Promise<Read | "gone" | "skipped"> {
  const { workspaceId, sourceId, playbookId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return "gone";
  const found = await tenantClient.signalFoundCompany.findFirst({ where: { id: foundCompanyId } });
  if (found === null || found.verdict !== "fit" || found.peopleTakenAt !== null) return "skipped";
  const candidate = await tenantClient.signalResearchCandidate.findFirst({
    where: { sourceId, domain: found.domain },
    select: { id: true, queryId: true },
  });
  const plan = await tenantClient.signalResearchPlan.findFirst({
    where: { runId: ref.runId },
    select: { roleWords: true },
  });
  const query =
    candidate?.queryId == null
      ? null
      : await tenantClient.signalResearchQuery.findFirst({
          where: { id: candidate.queryId },
          select: { language: true },
        });
  const { icp } = await audienceOf(workspaceId, playbookId);
  const list = (values: readonly string[]) =>
    values.slice(0, INPUT_ITEMS_MAX).map((value) => clean(value, INPUT_ITEM_MAX));
  return {
    where: {
      ...{ workspaceId, runId: found.runId, domain: found.domain, pageUrl: found.pageUrl },
      candidateId: candidate?.id ?? null,
    },
    company: {
      ...{ foundCompanyId, name: found.name, companyId: found.companyId },
      ...{ country: found.country, phones: found.phones },
    },
    sourceLabel: source.label,
    eventKind: sourceKind(source.kind).event.kind,
    audience: { titles: list(icp.titles), seniorities: list(icp.seniorities) },
    roleWords: roleWordsOf(plan?.roleWords),
    language: query?.language ?? null,
  };
}

/** The people the pages name, gated; null when the model could not answer (its schema twice, or its budget). */
async function readPeople(
  ref: RunRef,
  read: Read,
  pages: Awaited<ReturnType<typeof peoplePagesOf>>,
) {
  const { workspaceId } = ref;
  const input = {
    company: { name: read.company.name, domain: read.where.domain },
    pages: pages.map((page) => ({ ...page, links: [...page.links], mailto: [...page.mailto] })),
  };
  // The workspace is the subject, so that a person's erasure deletes the record (evidence.ts).
  const call = { workspaceId, subjectRef: workspaceId, input };
  const client = givenClient();
  const options = client === undefined ? {} : { client };
  const result = await callAgent(readTask(), call, options).catch(overBudget);
  if (result === null || result.status !== "ok") return null;
  return gatePeople(result.output, pages, read.where.domain, read.company.phones);
}

/**
 * The people picked, the pick's first SIGNALS_RESEARCH_PEOPLE_PER_COMPANY, best first. The pick sees
 * roles and the audience's titles and seniorities only. With no title and no seniority in the audience
 * there is nothing to judge a role by, and the people are taken in the page's order. Null when the model
 * could not answer.
 */
async function pickPeople<T extends GatedPerson>(
  ref: RunRef,
  read: Read,
  people: readonly T[],
  cap: number,
): Promise<T[] | null> {
  if (people.length === 0) return [];
  const { titles, seniorities } = read.audience;
  if (titles.length === 0 && seniorities.length === 0) return people.slice(0, cap);
  const input = pickInputOf(people, read.audience, cap);
  const call = { workspaceId: ref.workspaceId, subjectRef: ref.sourceId, input };
  const client = givenClient();
  const options = client === undefined ? {} : { client };
  const result = await callAgent(pickTask(), call, options).catch(overBudget);
  if (result === null || result.status !== "ok") return null;
  return chosenOf(people, result.output, cap);
}

/**
 * The managers by search (managers.ts), when the pages gave fewer picked people than the limit: the
 * people the search gave that no page named, picked on their roles for the places left. Nobody for a
 * company whose pages filled the limit (no search is asked), or a plan with no role words; null when the
 * model could not answer (the step is `failed`, as for the pick).
 */
async function pickManagers(
  ref: RunRef,
  read: Read,
  pagePeople: readonly GatedPerson[],
  taken: number,
  tenant: TenantRun,
): Promise<{ people: PickedPerson[]; counts: Record<string, number> } | null> {
  const room = settings.SIGNALS_RESEARCH_PEOPLE_PER_COMPANY - taken;
  if (room <= 0 || read.roleWords.length === 0) return { people: [], counts: {} };
  const { foundCompanyId, name: companyName, country } = read.company;
  const ask = { foundCompanyId, companyName, country, roleWords: read.roleWords };
  const managers = await takeManagers(ref, { ...ask, language: read.language }, pagePeople, tenant);
  if (managers === null) return null;
  const picked = await pickPeople(ref, read, managers.people, room);
  if (picked === null) return null;
  const people: PickedPerson[] = picked.map(({ title, ...person }) => ({
    ...person,
    managers: { title, address: `https://${read.where.domain}/` },
  }));
  return { people, counts: managers.counts };
}

/** A call over its budget is no answer; any other failure is thrown, for the activity's attempts. */
function overBudget(error: unknown): null {
  if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
  throw error;
}

/** The tasks the host registered at start (loadAgentTasks); never imported here (agents/). */
function readTask(): typeof researchReadPeopleTask {
  return registered(RESEARCH_READ_PEOPLE) as unknown as typeof researchReadPeopleTask;
}
function pickTask(): typeof researchPickPeopleTask {
  return registered(RESEARCH_PICK_PEOPLE) as unknown as typeof researchPickPeopleTask;
}
function registered(name: string) {
  const task = registeredAgentTasks().get(name);
  if (task === undefined) throw new AppError(errors.signal_research_people_agent_not_loaded);
  return task;
}
