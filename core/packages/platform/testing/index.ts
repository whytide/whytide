// The shared test factories (docs/rules/coding.md §10, §11): synthetic data seeded per test, so a run
// repeats and no fixture names a real person; a buffer destination for the logger; an assertion on
// the AppError code a call throws.
import assert from "node:assert/strict";
import { isAppError } from "../errors/index.ts";

export type SyntheticPerson = {
  first_name: string;
  last_name: string;
  email: string;
  linkedin_url: string;
  company: string;
};
export type Synthetic = ReturnType<typeof synthetic>;

const FIRST = [
  "Ada",
  "Bao",
  "Chidi",
  "Dana",
  "Elif",
  "Femi",
  "Greta",
  "Hiro",
  "Ines",
  "Jun",
  "Kai",
  "Lena",
  "Mika",
  "Noor",
  "Omar",
  "Pia",
];
const LAST = [
  "Example",
  "Sample",
  "Fixture",
  "Specimen",
  "Placeholder",
  "Testwell",
  "Mockridge",
  "Dummyfield",
];
const WORDS = [
  "Blue",
  "Harbor",
  "Quiet",
  "Summit",
  "Copper",
  "Meadow",
  "Signal",
  "Northern",
  "Lantern",
  "Orbit",
  "Granite",
  "Willow",
];
const SUFFIX = ["Labs", "Systems", "Works", "Analytics", "Partners", "Studio"];

/** A generator seeded by the test: the same seed gives the same sequence. Addresses end in example.com or .invalid. */
export function synthetic(seed: string | number) {
  let state = hash(String(seed));
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  const slug = (...parts: string[]) => parts.join("-").toLowerCase();
  const generator = {
    int,
    pick,
    firstName: () => pick(FIRST),
    lastName: () => pick(LAST),
    company: () => `${pick(WORDS)} ${pick(WORDS)} ${pick(SUFFIX)}`,
    domain: () => `${slug(pick(WORDS), pick(WORDS))}.example.com`,
    url: (path = "") => `https://${generator.domain()}/${path}`,
    email: (first = pick(FIRST), last = pick(LAST)) => `${slug(first, last)}@example.com`,
    linkedinUrl: (first = pick(FIRST), last = pick(LAST)) =>
      `https://linkedin.invalid/in/${slug(first, last)}-${int(1e6).toString(36)}`,
    person(): SyntheticPerson {
      const [first, last] = [pick(FIRST), pick(LAST)];
      return {
        first_name: first,
        last_name: last,
        email: generator.email(first, last),
        linkedin_url: generator.linkedinUrl(first, last),
        company: generator.company(),
      };
    },
  };
  return generator;
}

function hash(text: string): number {
  let h = 1779033703 ^ text.length;
  for (const char of text) {
    h = Math.imul(h ^ char.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/** A pino destination that keeps the lines: `createLogger({ destination: logs.destination })`. */
export function collectLogs() {
  const raw: string[] = [];
  return {
    raw,
    destination: {
      write(line: string) {
        raw.push(line);
      },
    },
    lines: () =>
      raw
        .flatMap((chunk) => chunk.split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(
    fn,
    (error: unknown) => isAppError(error) && error.code === code,
    `expected AppError ${code}`,
  );
}
