// Random times in a window (README "Time"; briefs RB-11.2.4, RB-23.4.2), pure but for the source of
// numbers, which is a parameter: production passes Math.random (spacing, not secrecy), tests a
// seeded source from synthetic(seed).
import { timeArgumentInvalid } from "./errors.ts";

export type RandomTimesInput = {
  readonly from: Date;
  readonly to: Date;
  readonly count: number;
  readonly minGapMs: number;
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

function draw(random: () => number): number {
  const value = random();
  if (!(value >= 0 && value < 1)) throw timeArgumentInvalid("random");
  return value;
}
