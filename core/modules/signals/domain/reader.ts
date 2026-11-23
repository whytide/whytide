// The signal reader (README.md "Rating"; gamma-p5-030), which loading this module registers
// with qualification's defineSignalReader (register-reader.ts): a person's events as intent's items,
// ids, codes, numbers and dates, and the person's own words for the assessment. It reads in the
// caller's tenant run, through tenantClient: a run of its own inside one is refused as nested.
import { tenantClient } from "@whytide/db";
import {
  INTENT_CLASSES,
  INTENT_KINDS,
  type IntentClass,
  type IntentInput,
  type IntentKind,
  type IntentRole,
  type SignalReader,
} from "@whytide/qualification";
import { registeredSourceKinds } from "../sources/registry.ts";

const DAY_MS = 86_400_000;
/** The role an item shows first: the author's, then a comment, then a reaction. */
const ROLE_RANK: Readonly<Record<IntentRole, number>> = {
  author: 0,
  comment: 1,
  reaction: 2,
  repost: 2,
};
type Item = Omit<IntentInput, "count">;

export const signalReader: SignalReader = { intentInputs, excerpts };

/**
 * The items of the persons' events since `since`. One person's events on one source, newest first,
 * collapse into windows of the event kind's lookback (RB-4.4.2): the newest opens a window, which
 * every event within the lookback before it joins, and the next older one opens another. A window is
 * one item with its count, showing the author's event, else a comment, else a reaction, then the
 * highest relevance, then the newest. A deleted source's events (no source) collapse as one source's.
 */
async function intentInputs(input: {
  readonly personIds: readonly string[];
  readonly since: Date;
}): Promise<IntentInput[]> {
  if (input.personIds.length === 0) return [];
  const events = await tenantClient.signalEvent.findMany({
    where: {
      personId: { in: [...input.personIds] },
      occurredAt: { gte: input.since },
      kind: { in: [...INTENT_KINDS] },
    },
    select: {
      id: true,
      personId: true,
      sourceId: true,
      kind: true,
      occurredAt: true,
      relevance: true,
      intentClass: true,
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  // Two more reads: the tenant guard refuses a relation in a query's arguments.
  const evidence = await tenantClient.evidence.findMany({
    where: { eventId: { in: events.map(({ id }) => id) } },
    select: { eventId: true, reaction: true },
  });
  const sourceIds = [...new Set(events.flatMap(({ sourceId }) => sourceId ?? []))];
  const sources = await tenantClient.signalSource.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, createdBy: true },
  });
  const reactions = new Map(evidence.map((row) => [row.eventId, row.reaction]));
  const owners = new Map(sources.map((row) => [row.id, row.createdBy]));
  const groups = new Map<string, Item[]>();
  for (const event of events) {
    const sourceId = event.sourceId ?? "";
    const item: Item = {
      ...{ personId: event.personId, eventId: event.id, sourceId },
      kind: event.kind as IntentKind,
      role: roleOf(reactions.get(event.id)),
      relevance: event.relevance,
      intentClass: classOf(event.intentClass),
      occurredAt: event.occurredAt,
      ownerUserId: owners.get(sourceId) ?? null,
    };
    const key = `${event.personId}\u0000${sourceId}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const lookback = lookbackDaysOf();
  return [...groups.values()].flatMap((items) => collapsed(items, lookback));
}

/** A group's items, newest first, in windows of the lookback: each window's shown item, counted. */
function collapsed(items: readonly Item[], lookback: (kind: string) => number): IntentInput[] {
  const windows: Item[][] = [];
  let cut = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const at = item.occurredAt.getTime();
    if (at <= cut) {
      cut = at - lookback(item.kind) * DAY_MS;
      windows.push([]);
    }
    windows.at(-1)?.push(item);
  }
  return windows.map((window) => {
    const shown = window.reduce((best, item) => (shownFirst(item, best) < 0 ? item : best));
    return { ...shown, count: window.length };
  });
}

/** The author's item first, then a comment, then a reaction; then the highest relevance; the newest. */
function shownFirst(a: Item, b: Item): number {
  const role = ROLE_RANK[a.role] - ROLE_RANK[b.role];
  if (role !== 0) return role;
  const relevance = (b.relevance ?? -1) - (a.relevance ?? -1);
  return relevance !== 0 ? relevance : b.occurredAt.getTime() - a.occurredAt.getTime();
}

/**
 * Up to `max` of the person's own words not yet reduced, newest first: a comment, or an author's own
 * post, from the evidence's excerpt; never the excerpt of the post someone else wrote.
 */
async function excerpts(input: {
  readonly personId: string;
  readonly max: number;
}): Promise<string[]> {
  if (!(input.max >= 1)) return [];
  const events = await tenantClient.signalEvent.findMany({
    where: { personId: input.personId },
    select: { id: true },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  const rows = await tenantClient.evidence.findMany({
    where: { eventId: { in: events.map(({ id }) => id) }, excerpt: { not: null }, reducedAt: null },
    select: { eventId: true, excerpt: true },
  });
  const words = new Map(rows.map((row) => [row.eventId, row.excerpt]));
  return events.flatMap(({ id }) => words.get(id) ?? []).slice(0, Math.floor(input.max));
}

/** The evidence's reaction as intent's role: `author`, `comment`, or a reaction (a like, a repost). */
function roleOf(reaction: string | null | undefined): IntentRole {
  return reaction === "author" || reaction === "comment" ? reaction : "reaction";
}

const classOf = (value: string | null): IntentClass | null =>
  (INTENT_CLASSES as readonly string[]).includes(value ?? "") ? (value as IntentClass) : null;

/**
 * Each event kind's lookback in days, as the reduction reads the kinds: two kinds of one event kind
 * the shorter, an event kind no kind declares the shortest of all; 1 without any kind.
 */
function lookbackDaysOf(): (eventKind: string) => number {
  const days = new Map<string, number>();
  for (const { lookbackDays, event } of registeredSourceKinds().values()) {
    days.set(event.kind, Math.min(lookbackDays, days.get(event.kind) ?? lookbackDays));
  }
  const shortest = days.size === 0 ? 1 : Math.min(...days.values());
  return (eventKind) => days.get(eventKind) ?? shortest;
}
