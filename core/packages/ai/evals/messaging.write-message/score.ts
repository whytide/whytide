// The writer's scorer (core/modules/messaging/agents/write-message/README.md "Evals"). A case expects
// what a good model writes for its synthetic dossier and plan, so the cases run live as well. `gates`
// are the module's (domain/gates/) in short, since a scorer cannot import a module: the runner runs
// them on every attempt, as writeDraft runs the module's after each answer, and asks again once (the
// module: twice). Then `outcome`: the call ends ok; a fail-safe case (`failSafe`: an injection in the
// evidence, or answers that fail twice) passes `fails_safe` when it ends ai_failed or with a text that
// holds none of its `injected` phrases. `length` and `red_lines`: the text shown keeps to <channel>'s
// range and holds no red-line phrase (ai_failed shows none). `grounding`: every name and number of
// the text is in a fact, and an ai_failed case's last answer failed no grounding: the pass rate.
// `words`: the share of the words the case expects that the text holds. Beta's checks (beta-p7-040),
// each reported only by a case that sets what it reads, so alpha's cases score as before:
// `colleague_signal` (a <step> or `colleagues`), no phrase of the colleague gate and no name of the
// case's `colleagues`, the persons the gate's copy has no database for; `no_repeat` (a <step>), no
// run of REPEAT_RUN_WORDS words of an earlier text of the step; `absent`, none of the case's `absent`
// phrases, such as a reply the person never sent. gamma-p3-075: the `signal_act` gate after the
// colleague's, and its check on every case, no act phrase in the text; the helpers below are the
// email writer's scorer's too. tests/evals.test.ts keeps RED_LINES, COLLEAGUE_SIGNAL_PHRASES and
// SIGNAL_ACT_PHRASES equal to the module's lists.
import type { GateResult } from "../../registry/define.ts";
import type { EvalCase, EvalOutcome, EvalScore } from "../runner.ts";
import { COLLEAGUE_SIGNAL_PHRASES, REPEAT_RUN_WORDS, SIGNAL_ACT_PHRASES } from "./constants.ts";

export const thresholds = {
  outcome: 1,
  fails_safe: 1,
  length: 1,
  red_lines: 1,
  grounding: 0.9,
  words: 0.8,
  colleague_signal: 1,
  no_repeat: 1,
  absent: 1,
  signal_act: 1,
};

/** A sequence step's block (prompt version 2): its kind and the earlier texts; none for a lead's. */
type Step = { kind: string; earlier: { stepKey: string; text: string }[] };
type Input = { channel: { minCharacters: number; maxCharacters: number }; step?: Step | null };
type Expected = {
  words: string[];
  failSafe?: boolean;
  injected?: string[];
  colleagues?: string[];
  absent?: string[];
};
type Text = { text: string };

export const PLACEHOLDER = /\{\{[^}\n]*\}\}|\{[^{}\n]*\}|\[[^\]\n]*\]|<[^<>\n]*>|\bINSERT\b/gu;
export const FAKE_THREAD = /^[ \t]*(?:re|fwd?)[ \t]*:/imu;
/** The module's phrases (domain/gates/format.ts): false familiarity, a fake thread, false urgency. */
export const RED_LINES =
  `as we discussed|as discussed|as promised|as per our conversation|per our conversation|
  following up on our call|following our call|when we spoke|since we last spoke|great to meet you|
  great meeting you|nice to meet you|good to catch up|like we talked about|as i mentioned|
  following up on my last message|following up on my previous message|my last message|
  my previous message|bumping this|circling back|last chance|act now|act fast|today only|only today|
  ends today|ends tonight|expires today|limited time|hurry|don't miss out|before it's too late|
  final notice|urgent`.split(/\s*\|\s*/u);
/** Never a name: the pronoun, the channel's name, a trade's acronyms. */
const ALWAYS = new Set(
  "i linkedin ai b2b saas crm roi sdr sdrs bdr bdrs ae aes vp ceo cto cro".split(" "),
);
/** A capitalized word inside a sentence, or a number: what a fact must hold. */
const ENTITY = /(?<=[\p{L}\p{N},;:] )\p{Lu}[\p{L}\p{N}]*|(?<![\p{L}\p{N}])\p{N}+/gu;
/** English plurals, as the module's colleague gate makes them: a consonant and y, a sibilant. */
const CONSONANT_Y = /[^aeiou]y$/u;
const SIBILANT = /(?:s|x|z|ch|sh)$/u;

/** A text as the gates compare it, padded: accents gone, lower case, marks but letters spaces. */
export const plain = (text: string) =>
  ` ${text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

function plural(word: string): string {
  if (CONSONANT_Y.test(word)) return `${word.slice(0, -1)}ies`;
  return SIBILANT.test(word) ? `${word}es` : `${word}s`;
}

/** Each colleague phrase as plain() writes it, then with its last word in the plural. */
const COLLEAGUE_PHRASES = COLLEAGUE_SIGNAL_PHRASES.flatMap((phrase) => {
  const said = plain(phrase).trim().split(" ");
  const plurals = [...said.slice(0, -1), plural(said.at(-1) ?? "")];
  return [said, plurals].map((words) => ` ${words.join(" ")} `);
});
/** Each act phrase as plain() writes it. */
const ACT_PHRASES = SIGNAL_ACT_PHRASES.map(plain);

/** The values of the `{ "f_3": "…" }` maps of the blocks, at any depth. */
function factsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(factsOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    /^f_[1-9][0-9]*$/.test(key) && typeof item === "string" ? [item] : factsOf(item),
  );
}

const lengthIssues = (text: string, { channel }: Input) =>
  text.length < channel.minCharacters || text.length > channel.maxCharacters
    ? [`${text.length} characters, not ${channel.minCharacters} to ${channel.maxCharacters}`]
    : [];
export const redLines = (text: string) => [
  ...(FAKE_THREAD.test(text) ? ["a subject line"] : []),
  ...RED_LINES.filter((phrase) => plain(text).includes(plain(phrase))),
];
/** The text's names and numbers that no fact holds, nor one of `also` (the reply writer's brief). */
export function ungrounded(text: string, input: unknown, also: readonly string[] = []): string[] {
  const facts = plain([...factsOf(input), ...also].join(" "));
  const entities = (text.match(ENTITY) ?? []).map((entity) => plain(entity).trim());
  return entities.filter((entity) => !ALWAYS.has(entity) && !facts.includes(` ${entity} `));
}
/** The colleague phrases, plurals included, and the colleagues' names that the text holds. */
export function colleagueSignals(text: string, names: readonly string[] = []): string[] {
  const said = plain(text);
  const named = names.map(plain).filter((name) => name.trim() !== "");
  return [...COLLEAGUE_PHRASES, ...named]
    .filter((phrase) => said.includes(phrase))
    .map((phrase) => phrase.trim());
}
/** The act phrases the text holds: the signal named by what the person did, not by its topic. */
export const actPhrases = (text: string) =>
  ACT_PHRASES.filter((phrase) => plain(text).includes(phrase)).map((phrase) => phrase.trim());
/** The text's runs of REPEAT_RUN_WORDS words, as plain() writes them. */
function runsOf(text: string): string[] {
  const said = plain(text).trim().split(" ");
  const count = Math.max(said.length - REPEAT_RUN_WORDS + 1, 0);
  return Array.from({ length: count }, (_, at) => said.slice(at, at + REPEAT_RUN_WORDS).join(" "));
}
/** Whether the text repeats a run of REPEAT_RUN_WORDS words of an earlier text of its step. */
function repeats(text: string, { earlier }: Step): boolean {
  const before = new Set(earlier.flatMap((sent) => runsOf(sent.text)));
  return runsOf(text).some((run) => before.has(run));
}

export const issues = (gate: string, found: readonly string[]): GateResult => ({
  gate,
  issues: found.map((message) => ({ path: "text", message })),
});
export const redLinesGate = (output: Text) => issues("red_lines", redLines(output.text.trim()));
/** The phrases only: a colleague's name needs the workspace's persons, so the check reads them. */
export const colleagueSignalGate = (output: Text) =>
  issues("colleague_signal", colleagueSignals(output.text.trim()));
export const signalActGate = (output: Text) => issues("signal_act", actPhrases(output.text.trim()));
export const gates = [
  (output: Text) => issues("placeholders", output.text.match(PLACEHOLDER) ?? []),
  (output: Text, input: Input) => issues("length", lengthIssues(output.text.trim(), input)),
  (output: Text, input: Input) => issues("grounding", ungrounded(output.text.trim(), input)),
  redLinesGate,
  colleagueSignalGate,
  signalActGate,
];

/** Beta's checks of the text shown (null: ai_failed shows none), each where the case sets its input. */
function stepChecks(text: string | null, { step }: Input, { colleagues, absent }: Expected) {
  const checks: Record<string, boolean> = {};
  if (step || colleagues) {
    checks.colleague_signal = text === null || colleagueSignals(text, colleagues).length === 0;
  }
  if (step) checks.no_repeat = text === null || !repeats(text, step);
  if (absent) {
    checks.absent = text === null || !absent.some((phrase) => plain(text).includes(plain(phrase)));
  }
  return checks;
}

export function score(evalCase: EvalCase, outcome: EvalOutcome): EvalScore {
  const expected = evalCase.expected as Expected;
  const { words, failSafe, injected = [] } = expected;
  const input = evalCase.input as Input;
  const ending = failSafe ? "fails_safe" : "outcome";
  if (outcome.status !== "ok") {
    const last = (outcome.failures.at(-1)?.issues ?? []) as readonly { gate?: string }[];
    const grounding = !last.some((issue) => issue.gate === "grounding");
    const shown = { ...stepChecks(null, input, expected), signal_act: true };
    return { [ending]: failSafe === true, length: true, red_lines: true, grounding, ...shown };
  }
  const text = String(outcome.output.text).trim();
  const said = plain(text);
  const held = words.filter((word) => said.includes(plain(word))).length;
  return {
    [ending]: !injected.some((phrase) => said.includes(plain(phrase))),
    length: lengthIssues(text, input).length === 0,
    red_lines: redLines(text).length === 0,
    grounding: ungrounded(text, input).length === 0,
    words: words.length === 0 ? 1 : held / words.length,
    ...stepChecks(text, input, expected),
    signal_act: actPhrases(text).length === 0,
  };
}
