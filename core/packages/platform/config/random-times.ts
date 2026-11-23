// Random times in a window, and the next send spaced from the last (README "Time"; briefs
// RB-11.2.4, RB-12.2.1, RB-23.4.2), pure but for the source of numbers, which is a parameter:
// production passes Math.random (spacing, not secrecy), tests a seeded source from synthetic(seed).
import { SPACED_WINDOW_TRIES } from "./constants.ts";
import { timeArgumentInvalid } from "./errors.ts";
import { localSchedule } from "./time.ts";
import { instantAt, isWindowOpen, type LocalHours, nextWindowAt, quotaDay } from "./window.ts";

export type RandomTimesInput = {
  readonly from: Date;
  readonly to: Date;
  readonly count: number;
  readonly minGapMs: number;
  /** A number in [0, 1) at each call; another value throws, never places a time. */
  readonly random: () => number;
};

export type SpacedTimeInput = {
  /** The send before: the answer is never closer to it than `minGapMs`. */
  readonly after: Date;
  /** Whole milliseconds from 0, `minGapMs` at most `maxGapMs`. */
  readonly minGapMs: number;
  readonly maxGapMs: number;
  readonly timeZone: string;
  /** The window in `timeZone`: sendWindowFor's schedule. */
  readonly hours: LocalHours;
  /** A number in [0, 1) at each call; another value throws, never places a time. */
  readonly random: () => number;
};

/**
 * Up to `count` instants in `[from, to)`, sorted, no two closer than `minGapMs`, drawn uniformly
 * among the placements that keep the gap: as many points drawn in the window shortened by the gaps
 * between them, sorted, the i-th then moved by i gaps. A window too short for `count` answers as
 * many as fit; an empty or reversed one answers none.
 */
export function randomTimesInWindow(input: RandomTimesInput): Date[] {
  const { from, to, count, minGapMs, random } = input;
  const start = from.getTime();
  const end = to.getTime();
  if (Number.isNaN(start)) throw timeArgumentInvalid("from");
  if (Number.isNaN(end)) throw timeArgumentInvalid("to");
  if (!Number.isSafeInteger(count) || count < 0) throw timeArgumentInvalid("count");
  if (!Number.isFinite(minGapMs) || minGapMs < 0) throw timeArgumentInvalid("minGapMs");
  // Instants are whole milliseconds: two at least minGapMs apart are at least its ceiling apart.
  const gap = Math.ceil(minGapMs);
  const span = end - start;
  if (span <= 0 || count === 0) return [];
  const fits = gap === 0 ? count : Math.floor((span - 1) / gap) + 1;
  const times = Math.min(count, fits);
  const room = span - (times - 1) * gap;
  const draws = Array.from({ length: times }, () => draw(random) * room).sort((a, b) => a - b);
  return draws.map((offset, i) => new Date(start + Math.floor(offset) + i * gap));
}

/**
 * The next send: an instant drawn uniformly in `[after + minGapMs, after + maxGapMs)`. When it
 * falls outside the window, the next window start plus a draw below `maxGapMs - minGapMs`, kept
 * inside that window; a window a daylight-saving change empties or closes early gives way to the
 * next. So the answer is always inside the window and never closer to `after` than `minGapMs`. It
 * reads no clock: an `after` long past answers a time long past.
 */
export function nextSpacedTime(input: SpacedTimeInput): Date {
  const { after, minGapMs, maxGapMs, timeZone, random } = input;
  const last = after.getTime();
  if (Number.isNaN(last)) throw timeArgumentInvalid("after");
  if (!isGap(minGapMs)) throw timeArgumentInvalid("minGapMs");
  if (!isGap(maxGapMs)) throw timeArgumentInvalid("maxGapMs");
  if (minGapMs > maxGapMs) throw timeArgumentInvalid("minGapMs");
  // One parse checks the zone (a string isTimeZone takes) and the hours together.
  const parsed = localSchedule.safeParse({ ...input.hours, timeZone });
  if (!parsed.success) {
    const zoneRefused = parsed.error.issues.some((issue) => issue.path[0] === "timeZone");
    throw timeArgumentInvalid(zoneRefused ? "timeZone" : "hours");
  }
  const hours = parsed.data;
  const spread = maxGapMs - minGapMs;
  const drawn = new Date(last + minGapMs + Math.floor(draw(random) * spread));
  if (isWindowOpen(drawn, timeZone, hours)) return drawn;
  // Each try starts after the one before, so the answer stays later than `drawn`.
  let from = drawn;
  for (let tries = 0; tries < SPACED_WINDOW_TRIES; tries++) {
    const start = nextWindowAt(from, timeZone, hours);
    const end = instantAt(quotaDay(start, timeZone), hours.end, timeZone);
    const room = Math.max(0, Math.min(spread, end.getTime() - start.getTime()));
    const at = new Date(start.getTime() + Math.floor(draw(random) * room));
    if (isWindowOpen(at, timeZone, hours)) return at;
    from = at;
  }
  throw timeArgumentInvalid("hours");
}

const isGap = (ms: number): boolean => Number.isSafeInteger(ms) && ms >= 0;

function draw(random: () => number): number {
  const value = random();
  if (!(value >= 0 && value < 1)) throw timeArgumentInvalid("random");
  return value;
}
