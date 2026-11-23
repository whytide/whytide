// The reply golden set as extra cases (README.md beside this file; gamma-p7-065): `--cases <file>`
// reads a file of inbox's export, one JSON line per labeled reply (core/modules/inbox README "The
// reply golden set"; gamma-p7-060's line, beta's accepted), and each line becomes a case
// `golden-<line number>`: `input` built as inbox's classifier builds it (the last messages before the
// reply as `<thread>`, `lead` for an inbound one, each text cut to the model's bound), and `expected`
// the owner's 7-label `class_label`, or beta's word only as `{ positive }`. The file is personal data:
// its lines stay in memory, and an error names a line's number, never its text.
import { z } from "zod";
import { GOLDEN_PREFIX } from "../constants.ts";
import type { EvalCase } from "../runner.ts";
import {
  CLASSIFY_TEXT_MAX,
  CLASSIFY_THREAD_MESSAGES,
  GOLDEN_FAKE,
  POSITIVE_WORD,
} from "./constants.ts";

const at = z.iso.datetime({ offset: true });
/** The keys a case reads; the line's others (hashes, `channel`, `classification`) are ignored. */
const goldenLine = z.object({
  label: z.enum([POSITIVE_WORD, "not_positive"]),
  class_label: z
    .string()
    .regex(/^[a-z][a-z_]*$/)
    .nullish(),
  received_at: at,
  text: z.string(),
  earlier: z.array(z.object({ direction: z.enum(["in", "out"]), text: z.string(), at })),
});

/** A UTC day, `YYYY-MM-DD`, as the classifier's input takes it. */
const dayOf = (instant: string) => new Date(instant).toISOString().slice(0, 10);

/** Each line of the golden file as a case; a blank line is skipped, a broken one throws. */
export function goldenCases(file: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const [index, raw] of file.split(/\r?\n/).entries()) {
    if (raw.trim() === "") continue;
    const number = index + 1;
    let line: z.output<typeof goldenLine>;
    try {
      line = goldenLine.parse(JSON.parse(raw));
    } catch {
      throw new Error(`line ${number} is not a line of the reply golden set`);
    }
    const thread = line.earlier.slice(-CLASSIFY_THREAD_MESSAGES).map((message) => ({
      from: message.direction === "in" ? "lead" : "seller",
      day: dayOf(message.at),
      text: message.text.slice(0, CLASSIFY_TEXT_MAX.thread),
    }));
    const reply = {
      day: dayOf(line.received_at),
      text: line.text.slice(0, CLASSIFY_TEXT_MAX.reply),
    };
    cases.push({
      name: `${GOLDEN_PREFIX}${number}`,
      input: { thread, reply },
      fake: [GOLDEN_FAKE],
      expected: line.class_label
        ? { label: line.class_label }
        : { positive: line.label === POSITIVE_WORD },
    });
  }
  return cases;
}
