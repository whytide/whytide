// The daily plan's rules (docs/flows.md "The daily plan"), pure: which of an account's scheduled
// steps keep their times, which are placed again, which due steps get a time today within the
// capacity and one touch per person a day, and the times, drawn at random over the free parts of
// the window and kept a gap from each other and from every kept time. account.ts reads the rows and
// writes the answers.
import { randomTimesInWindow } from "@whytide/platform";
import {
  ACTION_ORDER,
  MIN_ACTION_GAP_MS,
  type PlanAction,
  TOUCHES_PER_PERSON_PER_DAY,
} from "./constants.ts";

/** A `scheduled` step as the plan reads it: ids, its action and order, its times. */
export type PlanStep = {
  readonly id: string;
  readonly personId: string;
  readonly actionType: PlanAction;
  readonly position: number;
  readonly dueAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly quotaDay: string | null;
};

/** What the account may still send today (linkedin's remainingToday), all within `actions`. */
export type Capacity = {
  readonly invites: number;
  readonly messages: number;
  readonly withdrawals: number;
  readonly actions: number;
};

/** The account's scheduled steps by their times at `at`. */
export type SortedSteps = {
  /** Placed on today's quota day, ahead of `at` or less than a gap behind: they keep their times. */
  readonly kept: readonly PlanStep[];
  /** Placed more than a gap before `at`, or on another quota day: their times go back to null. */
  readonly stale: readonly PlanStep[];
  /** Due and unplaced, the stale ones among them, in the order capacity is given. */
  readonly candidates: readonly PlanStep[];
};

/** Which steps keep, lose or get a time today. */
export type ChosenSteps = {
  /** The kept steps within the capacity, earliest first. */
  readonly kept: readonly PlanStep[];
  /** The latest kept steps past the capacity: their times go back to null. */
  readonly dropped: readonly PlanStep[];
  /** The candidates to place, in order: the earliest take the earliest times. */
  readonly chosen: readonly PlanStep[];
};

const CAPACITY_OF = {
  message: "messages",
  withdraw: "withdrawals",
  invite: "invites",
} as const satisfies Record<PlanAction, keyof Capacity>;

/** Step 4: kept, stale and candidates; a step not due yet, or with no due time, is no candidate. */
export function sortSteps(steps: readonly PlanStep[], at: Date, today: string): SortedSteps {
  const kept: PlanStep[] = [];
  const stale: PlanStep[] = [];
  const unplaced: PlanStep[] = [];
  for (const step of steps) {
    if (step.scheduledFor === null) unplaced.push(step);
    else if (isKept(step, at, today)) kept.push(step);
    else stale.push(step);
  }
  const due = (step: PlanStep) => step.dueAt !== null && step.dueAt <= at;
  const candidates = [...unplaced, ...stale].filter(due).sort(byOrder);
  return { kept, stale, candidates };
}

/**
 * Steps 5 to 7: the kept steps within each type's capacity and the actions left, the latest past
 * them dropped; then the candidates in order, each taken while its type and the actions have room,
 * unless its person has a kept step today, a touch today (`touched`, which holds the persons gone
 * too) or an earlier candidate in this run: only a person's first candidate is ever taken.
 */
export function chooseSteps(input: {
  readonly kept: readonly PlanStep[];
  readonly candidates: readonly PlanStep[];
  readonly capacity: Capacity;
  readonly touched: ReadonlySet<string>;
}): ChosenSteps {
  const { capacity, touched } = input;
  const used = { messages: 0, withdrawals: 0, invites: 0, actions: 0 };
  const room = (action: PlanAction) =>
    used[CAPACITY_OF[action]] < capacity[CAPACITY_OF[action]] && used.actions < capacity.actions;
  const take = (action: PlanAction) => {
    used[CAPACITY_OF[action]] += 1;
    used.actions += 1;
  };
  const kept: PlanStep[] = [];
  const dropped: PlanStep[] = [];
  for (const step of [...input.kept].sort(byTime)) {
    if (!room(step.actionType)) dropped.push(step);
    else {
      take(step.actionType);
      kept.push(step);
    }
  }
  const touches = new Map<string, number>();
  const count = (personId: string) => touches.get(personId) ?? 0;
  const touch = (personId: string) => touches.set(personId, count(personId) + 1);
  for (const step of kept) touch(step.personId);
  for (const personId of touched) touch(personId);
  const chosen: PlanStep[] = [];
  for (const step of input.candidates) {
    const free = count(step.personId) < TOUCHES_PER_PERSON_PER_DAY;
    touch(step.personId); // seen: a later candidate of the person waits
    if (!free || !room(step.actionType)) continue;
    take(step.actionType);
    chosen.push(step);
  }
  return { kept, dropped, chosen };
}

/**
 * Step 8: up to one time per item in `[from, to)`, never within MIN_ACTION_GAP_MS of a kept time or
 * of each other, drawn with randomTimesInWindow over the free parts of the window laid end to end, so
 * a gap is kept across a kept time too; a time where `open` says the window is closed (a window's end
 * that a spring-forward skips) is left out. Sorted: the first items take the earliest times, and the
 * items past what fits get none.
 */
export function placeTimes<T>(input: {
  readonly items: readonly T[];
  readonly from: Date;
  readonly to: Date;
  readonly kept: readonly Date[];
  readonly random: () => number;
  readonly open: (at: Date) => boolean;
}): { readonly item: T; readonly at: Date }[] {
  const { items, from, to, random, open } = input;
  const parts = freeParts(from.getTime(), to.getTime(), input.kept);
  const [first] = parts;
  if (first === undefined || items.length === 0) return [];
  const length = parts.reduce((sum, part) => sum + part.end - part.start, 0);
  const drawn = randomTimesInWindow({
    from: new Date(first.start),
    to: new Date(first.start + length),
    count: items.length,
    minGapMs: MIN_ACTION_GAP_MS,
    random,
  });
  const times = drawn.map((time) => along(parts, time.getTime() - first.start)).filter(open);
  return times.map((at, index) => ({ item: items[index] as T, at }));
}

type Part = { readonly start: number; readonly end: number };

/** `[from, to)` less every instant closer than the gap to a kept time, as sorted half-open parts. */
function freeParts(from: number, to: number, kept: readonly Date[]): Part[] {
  let parts: Part[] = from < to ? [{ start: from, end: to }] : [];
  for (const time of kept) {
    const tooClose = time.getTime() - MIN_ACTION_GAP_MS + 1; // the first instant too close to it
    const farEnough = time.getTime() + MIN_ACTION_GAP_MS; // the first instant far enough after it
    parts = parts.flatMap(({ start, end }) => {
      const before = { start, end: Math.min(end, tooClose) };
      const after = { start: Math.max(start, farEnough), end };
      return [before, after].filter((part) => part.start < part.end);
    });
  }
  return parts;
}

/** The instant `offset` milliseconds along the parts laid end to end. */
function along(parts: readonly Part[], offset: number): Date {
  let left = offset;
  for (const { start, end } of parts) {
    if (left < end - start) return new Date(start + left);
    left -= end - start;
  }
  throw new Error("an offset past the free parts"); // randomTimesInWindow keeps it inside
}

function isKept(step: PlanStep, at: Date, today: string): boolean {
  const behind = at.getTime() - (step.scheduledFor?.getTime() ?? 0);
  return step.quotaDay === today && behind < MIN_ACTION_GAP_MS;
}

/** Messages, then withdrawals, then invites; within a type by due time, position, then id. */
function byOrder(a: PlanStep, b: PlanStep): number {
  const action = ACTION_ORDER.indexOf(a.actionType) - ACTION_ORDER.indexOf(b.actionType);
  const due = (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0);
  return action || due || a.position - b.position || compareIds(a.id, b.id);
}

const byTime = (a: PlanStep, b: PlanStep) =>
  (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0) || compareIds(a.id, b.id);

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
