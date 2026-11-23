// The prompts' evals (README.md "Evals"): each task passes its cases on the fake with the checks
// it sets; a copy of qualification's cases with one expected verdict changed, and the writer's scorer
// without its red-line gate, fail naming the case. Without its colleague-signal gate the writer's
// scorer fails naming the colleague cases, and a text that names a case's colleague, repeats 8 words
// of an earlier text or claims a reply fails its check naming the case; the scorer's copies of
// messaging's phrase lists equal the module's, read as text (beta-p7-040). gamma-p3-075: the email
// writer's synthetic leads, a first email and a follow-up each; the LinkedIn writer's scorer without
// its signal-act gate, and the email writer's without its links, subject and signal-act gates, fail
// naming the cases those gates refuse, as an email naming a case's colleague or opening as its first
// email does; the act phrases' copy joins the lists' test. No case or run file holds a real address,
// and a live run's record keeps no text (a real name is the reviewer's check). The pipeline's step
// runs the evals when an agent's or an eval's file changed since main, and only then. gamma-p4-040:
// the reply classifier's synthetic cases, at least 40 and 4 per label; a copy whose case expects an
// opt-out the fake does not give, and whose reply keeps a name, fails naming those cases.
// gamma-p7-065: 200 of them, `syn-`, 20 per label and 40 opt-outs, no real address or link; the
// positive-against-rest checks and the opt-out recall over the right cases, the phrases first, read
// from inbox's file as text; the golden set's lines as cases (`--cases`), its refusals and its
// record; EVAL_LIVE=1 refused in the pipeline.
// gamma-en-065: the site reader's ten synthetic sites, one quote refused and asked again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { pathToFileURL } from "node:url";
import { evalsChanged } from "../evals/changes.ts";
import {
  CLASSIFY_CONSTANTS,
  CLASSIFY_TEXT_MAX,
  CLASSIFY_THREAD_MESSAGES,
  OPT_OUT_CONSTANTS,
} from "../evals/inbox.classify-reply/constants.ts";
import { goldenCases } from "../evals/inbox.classify-reply/golden.ts";
import {
  score as classifyScore,
  matchesOptOut,
  optOutLists,
} from "../evals/inbox.classify-reply/score.ts";
import {
  COLLEAGUE_SIGNAL_PHRASES,
  SIGNAL_ACT_PHRASES,
} from "../evals/messaging.write-message/constants.ts";
import { RED_LINES } from "../evals/messaging.write-message/score.ts";
import { type EvalCase, type EvalOutcome, type EvalReport, runRecord } from "../evals/runner.ts";

const pkg = join(import.meta.dirname, "..");
const evals = join(pkg, "evals");
mkdirSync(join(pkg, ".tmp"), { recursive: true });
const tmp = mkdtempSync(join(pkg, ".tmp", "evals-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const QUALIFY = "qualification.assess-fit";
const PLAN = "messaging.plan-message";
const WRITE = "messaging.write-message";
const EMAIL = "messaging.write-email";
const REPLY = "messaging.write-reply";
const CLASSIFY = "inbox.classify-reply";
const evalRun = (...args: string[]) =>
  spawnSync(process.execPath, ["evals/run.ts", ...args], {
    cwd: pkg,
    encoding: "utf8",
    env: { ...process.env, EVAL_LIVE: "0" },
  });
const scorerOf = (task: string) => pathToFileURL(join(evals, task, "score.ts")).href;
/** A task's eval's last line when it fails, naming each check below its threshold and its cases. */
const failedLine = (task: string, why: string) =>
  new RegExp(`^eval: failed: ${task.replaceAll(".", "\\.")} \\(${why}\\)$`, "m");
const writerFailed = (why: string) => failedLine(WRITE, why);
/** A copy of the writer's eval whose scorer runs every gate but the one it exports as `gate`. */
const writerWithout = (gate: string) =>
  copyOf(
    WRITE,
    [
      `import * as scorer from "${scorerOf(WRITE)}";`,
      "export const { score, thresholds } = scorer;",
      `export const gates = scorer.gates.filter((gate) => gate !== scorer.${gate});`,
      "",
    ].join("\n"),
  );

/** evals/<task>/ copied to a folder of its own, its cases changed by `edit`, its scorer `scorer`. */
function copyOf(task: string, scorer: string, edit?: (cases: Case[]) => void): string {
  const dir = mkdtempSync(join(tmp, "copy-"));
  const cases = JSON.parse(readFileSync(join(evals, task, "cases.json"), "utf8"));
  edit?.(cases);
  mkdirSync(join(dir, task));
  writeFileSync(join(dir, task, "cases.json"), JSON.stringify(cases));
  writeFileSync(join(dir, task, "score.ts"), scorer);
  return dir;
}
type Case = {
  name: string;
  fake: { text: string; body: string }[];
  expected: { verdicts: Record<string, string> };
};
type ClassifyCase = {
  name: string;
  input: { reply: { text: string } };
  expected: { synthetic: boolean; label: string };
};
type ClassifyFake = { name: string; fake: Record<string, unknown>[] };
const classifyCases = (): ClassifyCase[] =>
  JSON.parse(readFileSync(join(evals, CLASSIFY, "cases.json"), "utf8"));
/** Folders outside the repository, as the owner keeps the golden file. */
const away = mkdtempSync(join(tmpdir(), "whytide-golden-"));
after(() => rmSync(away, { recursive: true, force: true }));
const outside = () => mkdtempSync(join(away, "golden-"));

it("passes each task on the fake, each check over its cases at its threshold", () => {
  const suites = {
    "icp.draft-profile": { outcome: [2, 1], fails_safe: [1, 1], fields: [3, 0.8] },
    [QUALIFY]: { outcome: [30, 1], fails_safe: [7, 1], verdicts: [37, 0.8], anonymized: [5, 1] },
    [PLAN]: { outcome: [18, 1], angle: [18, 0.8] },
    [WRITE]: {
      outcome: [28, 1],
      fails_safe: [6, 1],
      length: [34, 1],
      grounding: [34, 0.9],
      colleague_signal: [12, 1],
      no_repeat: [12, 1],
      absent: [6, 1],
      signal_act: [34, 1],
    },
    [EMAIL]: {
      outcome: [18, 1],
      fails_safe: [2, 1],
      subject: [20, 1],
      length: [20, 1],
      links: [10, 1],
      grounding: [20, 0.9],
      red_lines: [20, 1],
      colleague_signal: [20, 1],
      signal_act: [20, 1],
      no_repeat: [10, 1],
      words: [20, 0.8],
    },
    [REPLY]: {
      outcome: [7, 1],
      fails_safe: [1, 1],
      length: [8, 1],
      grounding: [8, 1],
      red_lines: [8, 1],
      signal_act: [8, 1],
      absent: [3, 1],
      language: [1, 1],
      words: [8, 0.8],
    },
    "enrichment.name-country": { country: [21, 0.9], no_guess: [5, 1], fails_safe: [4, 1] },
    "onboarding.draft-company-knowledge": {
      outcome: [10, 1],
      fails_safe: [2, 1],
      sources: [11, 1],
    },
    "enrichment.read-company-site": {
      outcome: [8, 1],
      fails_safe: [2, 1],
      grounded: [10, 1],
      no_guess: [4, 1],
    },
    "signals.rate-engagement": {
      outcome: [4, 1],
      fails_safe: [2, 1],
      classes: [6, 0.8],
      relevance: [6, 0.8],
    },
    "signals.research-plan": {
      outcome: [11, 1],
      fails_safe: [4, 1],
      scope: [15, 1],
      fresh: [15, 1],
      no_person: [15, 1],
      words: [15, 1],
      uses_found: [2, 1],
      avoids_not_fit: [3, 1],
      role_words: [3, 1],
    },
    "signals.research-pick-results": {
      outcome: [6, 1],
      fails_safe: [1, 1],
      valid: [7, 1],
      recall: [7, 1],
      precision: [7, 1],
      first: [7, 1],
    },
    "signals.research-read-page": {
      outcome: [6, 1],
      fails_safe: [1, 1],
      kind: [7, 1],
      grounded: [7, 1],
      no_person: [7, 1],
      recall: [7, 1],
      precision: [7, 1],
    },
    "signals.research-judge-company": {
      outcome: [8, 1],
      fails_safe: [1, 1],
      verdict: [9, 1],
      grounded: [9, 1],
      no_person: [9, 1],
    },
    "signals.research-read-people": {
      outcome: [8, 1],
      fails_safe: [2, 1],
      grounded: [10, 1],
      recall: [10, 1],
      precision: [10, 1],
      phones: [10, 1],
    },
    "signals.research-read-result": {
      outcome: [4, 1],
      fails_safe: [1, 1],
      grounded: [5, 1],
      recall: [5, 1],
      precision: [5, 1],
    },
    "signals.research-pick-people": {
      outcome: [6, 1],
      fails_safe: [1, 1],
      blind: [7, 1],
      valid: [7, 1],
      recall: [7, 1],
      precision: [7, 1],
      first: [7, 1],
    },
    "signals.triage-engagers": {
      outcome: [7, 1],
      fails_safe: [1, 1],
      skips: [8, 1],
      decisions: [8, 0.8],
    },
    [CLASSIFY]: {
      label: [200, 0.9],
      opt_out_recall: [42, 1],
      fails_safe: [6, 1],
      masked: [5, 1],
      positive_recall: [26, 0.93],
      positive_precision: [26, 0.93],
    },
  };
  // The colleague and act gates refuse a first answer and ask again: ok after two attempts, or
  // ai_failed; the email's act, links and subject gates too.
  const rows: Record<string, RegExp[]> = {
    [WRITE]: [
      /^ {2}colleague-phrase-retry +ok +2 /m,
      /^ {2}colleague-phrase-twice +ai_failed gates +2 /m,
      /^ {2}v3-act-comment-retry +ok +2 /m,
    ],
    [EMAIL]: [
      /^ {2}reaction-speed-first +ok +2 /m,
      /^ {2}pain-founder-first +ok +2 /m,
      /^ {2}reaction-service-follow-up +ok +2 /m,
    ],
    // The reply's grounding refuses an invented price, its placeholders gate a link left out.
    [REPLY]: [/^ {2}brief-price-missing +ok +2 /m, /^ {2}placeholder-retry +ok +2 /m],
    // The gate refuses a class on an event without words, the schema a plain-text answer.
    "signals.rate-engagement": [
      /^ {2}b-noise-retried-after-a-class-without-words +ok +2 /m,
      /^ {2}b-injections-retried-after-plain-text +ok +2 /m,
    ],
    // The grounded gate refuses a quote not in its page (gamma-en-065).
    "enrichment.read-company-site": [/^ {2}garden-shop-misquote-retried +ok +2 /m],
    // The gate refuses a three-letter code; plain text then that code fail twice (gamma-en-075).
    "enrichment.name-country": [
      /^ {2}upper-austria-retried-after-a-code-of-three-letters +ok +2 /m,
      /^ {2}invalid-twice +ai_failed gates +2 /m,
    ],
    // The schema refuses a plain-text answer (gamma-wr-040).
    "signals.research-plan": [/^ {2}kestrel-retried-after-plain-text +ok +2 /m],
    // The gate refuses a number that is no result (gamma-wr-045).
    "signals.research-pick-results": [
      /^ {2}kestrel-retried-after-a-number-that-is-no-result +ok +2 /m,
    ],
    // The schema refuses a plain-text answer (gamma-wr-046).
    "signals.research-read-page": [/^ {2}kestrel-retried-after-plain-text +ok +2 /m],
    // The schema refuses a plain-text answer (gamma-wr-050).
    "signals.research-judge-company": [/^ {2}aurelia-retried-after-plain-text +ok +2 /m],
    // The schema refuses a plain-text answer; the pick's gate a number that is no person (gamma-wr-060).
    "signals.research-read-people": [/^ {2}aurelia-retried-after-plain-text +ok +2 /m],
    // The schema refuses a plain-text answer (gamma-wr-090).
    "signals.research-read-result": [/^ {2}aurelia-retried-after-plain-text +ok +2 /m],
    "signals.research-pick-people": [
      /^ {2}kestrel-retried-after-plain-text +ok +2 /m,
      /^ {2}aurelia-retried-after-a-number-that-is-no-person +ok +2 /m,
    ],
    // The gate refuses a skip without its code (signals-triage-ai).
    "signals.triage-engagers": [
      /^ {2}recruiter-skipped-retried-after-a-skip-without-its-code +ok +2 /m,
    ],
    // The gate refuses a return date on another label, the schema a plain-text answer.
    [CLASSIFY]: [
      /^ {2}syn-interested-plain-text-retry +ok +2 /m,
      /^ {2}syn-not-now-date-retry +ok +2 /m,
      /^ {2}syn-other-injection-date +ok +2 /m,
      /^ {2}syn-not-now-gate-twice +ai_failed gates +2 /m,
      /^ {2}syn-other-invalid-twice +ai_failed \S+ +2 /m,
    ],
  };
  for (const [task, checks] of Object.entries(suites)) {
    const run = evalRun(task);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    for (const [check, [cases, threshold]] of Object.entries(checks)) {
      const line = `^ {2}${check}: \\S+ over ${cases} cases, threshold ${threshold?.toFixed(2)}, pass`;
      assert.match(run.stdout, new RegExp(line, "m"), `${task}: ${check}`);
    }
    for (const row of rows[task] ?? []) assert.match(run.stdout, row, task);
  }
});

it("fails naming the case when a qualification case expects another verdict", () => {
  const dir = copyOf(QUALIFY, `export * from "${scorerOf(QUALIFY)}";\n`, (cases) => {
    const fit = cases.find((c) => c.name === "fleet-strong-fit");
    if (fit) fit.expected.verdicts.title_function = "not_met";
  });
  const run = evalRun(QUALIFY, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const failed =
    /^eval: failed: qualification\.assess-fit \(outcome 0\.97 under 1\.00: fleet-strong-fit\)$/m;
  assert.match(run.stdout, failed);
});

it("fails naming the classifier's case that expects an opt-out it does not get, and the one whose reply keeps a name", () => {
  const dir = copyOf(CLASSIFY, `export * from "${scorerOf(CLASSIFY)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ClassifyCase[]) {
      if (evalCase.name === "syn-not-interested-plain") evalCase.expected.label = "opt_out";
      const { reply } = evalCase.input;
      if (evalCase.name === "syn-interested-calendar-link")
        reply.text = reply.text.replace("[name]", "Noor");
    }
  });
  const run = evalRun(CLASSIFY, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const why = [
    "opt_out_recall 0.98 under 1.00: syn-not-interested-plain",
    "masked 0.80 under 1.00: syn-interested-calendar-link",
  ];
  assert.match(run.stdout, failedLine(CLASSIFY, why.join("; ")));
});

it("fails naming the research plan's cases whose scripted plan leaves the audience's countries, repeats a query the source asked, or holds an address", () => {
  const PLAN_TASK = "signals.research-plan";
  type Query = { country: string; text: string };
  type PlanCase = {
    name: string;
    input: { asked: Query[] };
    fake: { queries: Query[] }[];
  };
  const dir = copyOf(PLAN_TASK, `export * from "${scorerOf(PLAN_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PlanCase[]) {
      const first = evalCase.fake.at(-1)?.queries[0] as Query;
      if (evalCase.name === "kestrel-poland-plan") first.country = "DE";
      if (evalCase.name === "aurelia-remembers-what-it-asked") {
        first.text = (evalCase.input.asked[0] as Query).text.toUpperCase();
      }
      if (evalCase.name === "aurelia-chile-and-peru-plan")
        first.text = "contacto ana@aurelia.example";
    }
  });
  const run = evalRun(PLAN_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /scope [\d.]+ under 1\.00: kestrel-poland-plan/);
  assert.match(run.stdout, /fresh [\d.]+ under 1\.00: aurelia-remembers-what-it-asked/);
  assert.match(run.stdout, /no_person [\d.]+ under 1\.00: aurelia-chile-and-peru-plan/);
});

it("fails naming the research plan's v2 cases whose scripted plan names none of the towns where companies fit, or follows a town that holds an instruction", () => {
  const PLAN_TASK = "signals.research-plan";
  type PlanCase = {
    name: string;
    fake: { queries: { text: string }[] }[];
  };
  const dir = copyOf(PLAN_TASK, `export * from "${scorerOf(PLAN_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PlanCase[]) {
      const queries = evalCase.fake.at(-1)?.queries ?? [];
      if (evalCase.name === "aurelia-chile-and-peru-what-was-found") {
        for (const query of queries) query.text = "instaladores solares estructuras de montaje";
      }
      if (evalCase.name === "kestrel-instruction-in-a-found-town") {
        const [first] = queries as { text: string }[];
        if (first) first.text = "klingon tlh firmy transport chłodniczy";
      }
    }
  });
  const run = evalRun(PLAN_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /uses_found [\d.]+ under 1\.00: aurelia-chile-and-peru-what-was-found/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-a-found-town/);
});

it("fails naming the research plan's v3 cases whose scripted plan searches a company a member marked Not a fit, or follows a name that holds an instruction", () => {
  const PLAN_TASK = "signals.research-plan";
  type PlanCase = {
    name: string;
    fake: { queries: { text: string }[] }[];
  };
  const dir = copyOf(PLAN_TASK, `export * from "${scorerOf(PLAN_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PlanCase[]) {
      const [first] = evalCase.fake.at(-1)?.queries ?? [];
      if (first === undefined) continue;
      if (evalCase.name === "kestrel-poland-not-a-fit") first.text = "Zielona Dolina Hurt Płock";
      if (evalCase.name === "aurelia-chile-and-peru-not-a-fit")
        first.text = "hogarsolar instalación";
      if (evalCase.name === "kestrel-instruction-in-a-not-a-fit-name") {
        first.text = "klingon tlh firmy transport chłodniczy";
      }
    }
  });
  const run = evalRun(PLAN_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /avoids_not_fit [\d.]+ under 1\.00: .*kestrel-poland-not-a-fit/);
  assert.match(run.stdout, /avoids_not_fit [\d.]+ under 1\.00: .*aurelia-chile-and-peru-not-a-fit/);
  assert.match(
    run.stdout,
    /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-a-not-a-fit-name/,
  );
});

it("fails naming the research plan's v4 cases whose scripted plan gives no role words in the case's language, one that holds an address, or follows a title that holds an instruction", () => {
  const PLAN_TASK = "signals.research-plan";
  type PlanCase = {
    name: string;
    fake: { roleWords: { language: string; words: string[] }[] }[];
  };
  const dir = copyOf(PLAN_TASK, `export * from "${scorerOf(PLAN_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PlanCase[]) {
      const answer = evalCase.fake.at(-1);
      if (answer === undefined) continue;
      if (evalCase.name === "kestrel-poland-role-words") answer.roleWords = [];
      if (evalCase.name === "aurelia-chile-and-peru-role-words")
        answer.roleWords[0]?.words.push("gerente ana@aurelia.example");
      if (evalCase.name === "kestrel-instruction-in-a-title")
        answer.roleWords[0]?.words.push("tlhIngan Hol");
    }
  });
  const run = evalRun(PLAN_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /role_words [\d.]+ under 1\.00: .*kestrel-poland-role-words/);
  assert.match(run.stdout, /role_words [\d.]+ under 1\.00: .*aurelia-chile-and-peru-role-words/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-a-title/);
});

it("fails naming the result-picking cases whose scripted answer puts a worse result first, picks one nobody wanted, or leaves out the one worth reading", () => {
  const PICK_TASK = "signals.research-pick-results";
  type PickCase = { name: string; fake: { picks: { index: number }[] }[] };
  const dir = copyOf(PICK_TASK, `export * from "${scorerOf(PICK_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PickCase[]) {
      const last = evalCase.fake.length - 1;
      if (evalCase.name === "kestrel-company-sites") {
        evalCase.fake[last] = { picks: [{ index: 2 }, { index: 1 }] };
      }
      if (evalCase.name === "kestrel-fair-exhibitors-list") {
        evalCase.fake[last] = { picks: [{ index: 1 }, { index: 3 }] };
      }
      if (evalCase.name === "aurelia-members-directory") evalCase.fake[last] = { picks: [] };
    }
  });
  const run = evalRun(PICK_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /first [\d.]+ under 1\.00: kestrel-company-sites/);
  assert.match(run.stdout, /precision [\d.]+ under 1\.00: kestrel-fair-exhibitors-list/);
  assert.match(run.stdout, /recall [\d.]+ under 1\.00: aurelia-members-directory/);
});

it("fails naming the page-reading cases whose scripted answer invents a company or a quote, names a company from an instruction in the page, or leaves a good one out", () => {
  const READ_TASK = "signals.research-read-page";
  type Company = {
    name: string;
    link: null;
    place: null;
    quote: string | null;
    line: string | null;
  };
  const made = (name: string): Company => ({
    name,
    link: null,
    place: null,
    quote: null,
    line: null,
  });
  type ReadCase = { name: string; fake: { is: string; companies: Company[] }[] };
  const dir = copyOf(READ_TASK, `export * from "${scorerOf(READ_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ReadCase[]) {
      const last = evalCase.fake.length - 1;
      const answer = evalCase.fake[last];
      if (answer === undefined) continue;
      if (evalCase.name === "kestrel-fair-exhibitors-list") {
        answer.companies.push(made("Frigo Invent"));
      }
      if (evalCase.name === "kestrel-company-own-site") {
        const [first] = answer.companies;
        if (first) first.quote = "Firma założona w 1990 roku w Gdańsku";
      }
      if (evalCase.name === "aurelia-instruction-in-a-forum-page") {
        answer.companies.push(made("Megacorp Global"));
      }
      if (evalCase.name === "aurelia-award-notice-without-links") answer.companies.pop();
    }
  });
  const run = evalRun(READ_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*kestrel-fair-exhibitors-list/);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*kestrel-company-own-site/);
  assert.match(run.stdout, /precision [\d.]+ under 1\.00: .*kestrel-fair-exhibitors-list/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: aurelia-instruction-in-a-forum-page/);
  assert.match(run.stdout, /recall [\d.]+ under 1\.00: aurelia-award-notice-without-links/);
});

it("fails naming the company-judging cases whose scripted answer invents a quote, gives a person's address, or leaves the verdict to a page's instruction", () => {
  const JUDGE_TASK = "signals.research-judge-company";
  type Answer = { answer: string; line: string | null; quote: string | null; page: number | null };
  type JudgeCase = {
    name: string;
    fake: { focus: Answer; mustHaves: Answer[]; email: { kind: string } | null }[];
  };
  const dir = copyOf(JUDGE_TASK, `export * from "${scorerOf(JUDGE_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as JudgeCase[]) {
      const answer = evalCase.fake[evalCase.fake.length - 1];
      if (answer === undefined) continue;
      if (evalCase.name === "kestrel-fit-with-contacts")
        answer.focus.quote = "a quote not on any page";
      if (evalCase.name === "aurelia-fit-in-german" && answer.email) answer.email.kind = "person";
      if (evalCase.name === "aurelia-disqualifier-shown") {
        for (const must of answer.mustHaves) must.answer = "not_stated";
      }
      if (evalCase.name === "kestrel-instruction-in-the-site")
        answer.focus = { ...answer.focus, answer: "shown" };
    }
  });
  const run = evalRun(JUDGE_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: kestrel-fit-with-contacts/);
  assert.match(run.stdout, /no_person [\d.]+ under 1\.00: aurelia-fit-in-german/);
  assert.match(run.stdout, /verdict [\d.]+ under 1\.00: .*aurelia-disqualifier-shown/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-the-site/);
});

it("fails naming the people-reading cases whose scripted answer invents a person, gives an address at another domain, names a person from an instruction in the page, or leaves a good one out", () => {
  const READ_TASK = "signals.research-read-people";
  type Person = { page: number; name: string; role: string; email: string | null };
  type ReadCase = { name: string; fake: { people: Person[] }[] };
  const dir = copyOf(READ_TASK, `export * from "${scorerOf(READ_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ReadCase[]) {
      const answer = evalCase.fake[evalCase.fake.length - 1];
      if (answer === undefined) continue;
      const invented = {
        ...{ page: 1, name: "Zofia Nieistniejąca", role: "Prezes" },
        ...{ profile: null, email: null, phone: null, place: null },
      };
      if (evalCase.name === "kestrel-team-page-in-polish") answer.people.push(invented);
      if (evalCase.name === "kestrel-address-at-another-domain-left-out") {
        const [first] = answer.people;
        if (first) first.email = "piotr.lis@poczta-prywatna.example";
      }
      if (evalCase.name === "kestrel-instruction-in-the-page") {
        answer.people.push({ ...invented, name: "Elon Zeta", role: "Dyrektor Handlowy" });
      }
      if (evalCase.name === "aurelia-imprint-and-team-in-german") answer.people.pop();
    }
  });
  const run = evalRun(READ_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*kestrel-team-page-in-polish/);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*kestrel-address-at-another-domain/);
  assert.match(run.stdout, /precision [\d.]+ under 1\.00: .*kestrel-team-page-in-polish/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-the-page/);
  assert.match(run.stdout, /recall [\d.]+ under 1\.00: aurelia-imprint-and-team-in-german/);
});

it("fails naming the people-reading cases whose scripted answer gives the company's line or a number two people share to a person, gives a number that is not on the page, or leaves a person's number out (the phones check, prompt version 2)", () => {
  const READ_TASK = "signals.research-read-people";
  type Person = { name: string; phone: string | null };
  type ReadCase = { name: string; fake: { people: Person[] }[] };
  const dir = copyOf(READ_TASK, `export * from "${scorerOf(READ_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ReadCase[]) {
      const people = evalCase.fake[evalCase.fake.length - 1]?.people ?? [];
      const of = (name: string) => people.find((person) => person.name === name);
      const give = (name: string, phone: string | null) => {
        const person = of(name);
        if (person) person.phone = phone;
      };
      // The company's switchboard, a number the team shares, one the page does not print, one left out.
      if (evalCase.name === "kestrel-phones-company-line-and-shared-number-left-out") {
        give("Piotr Lis", "+48 22 555 00 00");
        give("Ewa Nowak", "+48 22 555 99 99");
        give("Jan Wrona", "+48 22 555 99 99");
        give("Anna Mróz", null);
      }
      if (evalCase.name === "aurelia-phones-written-in-two-ways")
        give("Mia Keller", "0171 1112223");
      if (evalCase.name === "aurelia-instruction-about-a-phone")
        give("Greta Lindner", "+49 170 0000000");
    }
  });
  const run = evalRun(READ_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /phones [\d.]+ under 1\.00: .*kestrel-phones-company-line/);
  assert.match(run.stdout, /phones [\d.]+ under 1\.00: .*aurelia-phones-written-in-two-ways/);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*aurelia-phones-written-in-two-ways/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: aurelia-instruction-about-a-phone/);
});

it("fails naming the result-reading cases whose scripted answer invents a person, gives a role the result does not hold, names a person from an instruction in a snippet, or leaves a good one out", () => {
  const READ_TASK = "signals.research-read-result";
  type Person = { result: number; name: string; role: string };
  type ReadCase = { name: string; fake: { people: Person[] }[] };
  const dir = copyOf(READ_TASK, `export * from "${scorerOf(READ_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ReadCase[]) {
      const answer = evalCase.fake[evalCase.fake.length - 1];
      if (answer === undefined) continue;
      if (evalCase.name === "kestrel-managers-in-polish")
        answer.people.push({ result: 3, name: "Zofia Nieistniejąca", role: "Prezes" });
      if (evalCase.name === "aurelia-managers-in-spanish") {
        const [first] = answer.people;
        if (first) first.role = "Gerente General";
      }
      if (evalCase.name === "kestrel-instruction-in-a-snippet")
        answer.people.push({ result: 1, name: "Elon Zeta", role: "Dyrektor Generalny" });
    }
  });
  const run = evalRun(READ_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*kestrel-managers-in-polish/);
  assert.match(run.stdout, /grounded [\d.]+ under 1\.00: .*aurelia-managers-in-spanish/);
  assert.match(run.stdout, /precision [\d.]+ under 1\.00: .*kestrel-managers-in-polish/);
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: kestrel-instruction-in-a-snippet/);
});

it("fails naming the people-picking cases whose input holds a name, whose scripted answer puts a worse role first or picks the role that tells it to be picked", () => {
  const PICK_TASK = "signals.research-pick-people";
  type PickCase = {
    name: string;
    input: { people: { index: number; role: string }[] };
    fake: { picks: { index: number }[] }[];
  };
  const dir = copyOf(PICK_TASK, `export * from "${scorerOf(PICK_TASK)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as PickCase[]) {
      const last = evalCase.fake.length - 1;
      if (evalCase.name === "kestrel-the-role-with-a-name-scrubbed") {
        const [first] = evalCase.input.people;
        if (first) first.role = "Dyrektor Handlowy Wiśniewska";
      }
      if (evalCase.name === "kestrel-sales-and-purchasing-roles-in-polish") {
        evalCase.fake[last] = { picks: [{ index: 3 }, { index: 2 }] };
      }
      if (evalCase.name === "aurelia-instruction-in-a-role") {
        evalCase.fake[last] = { picks: [{ index: 1 }, { index: 2 }] };
      }
    }
  });
  const run = evalRun(PICK_TASK, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /blind [\d.]+ under 1\.00: kestrel-the-role-with-a-name-scrubbed/);
  assert.match(
    run.stdout,
    /first [\d.]+ under 1\.00: kestrel-sales-and-purchasing-roles-in-polish/,
  );
  assert.match(run.stdout, /fails_safe [\d.]+ under 1\.00: aurelia-instruction-in-a-role/);
});

it("gives the classifier at least 200 synthetic cases, 20 for each of the 7 labels and 40 opt-outs", () => {
  const cases = classifyCases();
  assert.ok(cases.length >= 200, `${cases.length} cases`);
  assert.ok(cases.every(({ expected }) => expected.synthetic === true));
  const labels = Map.groupBy(cases, ({ expected }) => expected.label);
  assert.equal(labels.size, 7);
  for (const [label, of] of labels) assert.ok(of.length >= 20, `${label}: ${of.length} cases`);
  const optOuts = labels.get("opt_out") ?? [];
  assert.ok(optOuts.length >= 40, `opt_out: ${optOuts.length} cases`);
  // Phrasings beta's list does not match: the model's part of the recall.
  const unmatched = optOuts.filter(({ input }) => !matchesOptOut(input.reply.text));
  assert.ok(unmatched.length >= 10, `${unmatched.length} opt-outs the phrases miss`);
});

it("names every classifier case syn-, with no email address or link but a reserved one", () => {
  const cases = classifyCases();
  for (const { name } of cases) assert.match(name, /^syn-/);
  // Invented addresses and links only, on the reserved names (example, .test, .invalid), which the
  // cases need for the mask; a real person's name is the reviewer's check.
  const reserved = /^(?:[\w-]+\.)*(?:example|test|invalid)(?:\.(?:com|net|org))?$/;
  for (const evalCase of cases) {
    const text = JSON.stringify(evalCase.input).toLowerCase();
    const email = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
    const hosts = [
      ...text.matchAll(email),
      // Any other name with a dot and a top-level part, a link's host included.
      ...text.replace(email, " ").matchAll(/\b((?:[\w-]+\.)+[a-z]{2,})\b/g),
    ].map((match) => match[1] ?? "");
    for (const host of hosts) assert.match(host, reserved, `${evalCase.name}: ${host}`);
  }
});

it("reports positive recall and precision over the right cases, and the opt-out recall phrases first", () => {
  const answer = (label: string): EvalOutcome => ({
    status: "ok",
    output: { label, confidence: 0.9, returnDate: null },
    attempts: 1,
    failures: [],
  });
  const failed: EvalOutcome = { status: "ai_failed", reason: "schema", attempts: 2, failures: [] };
  const of = (expected: object, text = "Thanks."): EvalCase => ({
    name: "syn-a",
    input: { thread: [], reply: { day: "2026-11-10", text } },
    fake: ["-"],
    expected: { synthetic: true, ...expected },
  });
  const interested = of({ label: "interested" });
  assert.deepEqual(classifyScore(interested, answer("interested")), {
    label: true,
    positive_recall: true,
    positive_precision: true,
  });
  assert.deepEqual(classifyScore(interested, answer("other")), {
    label: false,
    positive_recall: false,
  });
  assert.deepEqual(classifyScore(of({ label: "not_now" }), answer("interested")), {
    label: false,
    positive_precision: false,
  });
  assert.deepEqual(classifyScore(of({ label: "not_now" }), failed), { label: false });
  // A miss the phrases catch is recalled; one they miss is not.
  const matched = of({ label: "opt_out" }, "Please remove me from your list.");
  const missed = of({ label: "opt_out" }, "Take me off your list.");
  assert.equal(classifyScore(matched, answer("not_interested")).opt_out_recall, true);
  assert.equal(classifyScore(missed, answer("not_interested")).opt_out_recall, false);
  assert.equal(classifyScore(missed, answer("opt_out")).opt_out_recall, true);
  // A golden line with beta's word only reports the two positive checks alone.
  const word = (positive: boolean) => ({ ...of({}), expected: { positive } });
  assert.deepEqual(classifyScore(word(true), answer("interested")), {
    positive_recall: true,
    positive_precision: true,
  });
  assert.deepEqual(classifyScore(word(false), answer("interested")), { positive_precision: false });
  assert.deepEqual(classifyScore(word(false), answer("other")), {});
  // A golden line's class compares the label alone: an owner records no return date.
  const away = { ...of({}), expected: { label: "out_of_office" } };
  const dated = {
    ...answer("out_of_office"),
    output: { label: "out_of_office", returnDate: "2026-11-20" },
  };
  assert.equal(classifyScore(away, dated as EvalOutcome).label, true);
});

it("counts a scripted opt-out miss the phrases match as recalled, and fails naming the one they miss", () => {
  const misses = ["syn-opt-out-remove-me", "syn-opt-out-take-me-off"];
  const dir = copyOf(CLASSIFY, `export * from "${scorerOf(CLASSIFY)}";\n`, (cases) => {
    for (const evalCase of cases as unknown as ClassifyFake[]) {
      if (misses.includes(evalCase.name))
        evalCase.fake = [{ ...evalCase.fake[0], label: "not_interested" }];
    }
  });
  const run = evalRun(CLASSIFY, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const why = "opt_out_recall 0.98 under 1.00: syn-opt-out-take-me-off";
  assert.match(run.stdout, failedLine(CLASSIFY, why));
});

it("reads inbox's opt-out phrases and the classifier's bounds from its files, as text", () => {
  const source = readFileSync(OPT_OUT_CONSTANTS, "utf8");
  const lists = optOutLists(source);
  const read = lists.phrases.length + lists.replies.length + (lists.stop ? 1 : 0);
  assert.ok(read >= 10, `${read} phrases read`);
  assert.ok(lists.phrases.includes("remove me") && lists.stop === "stop");
  assert.ok(lists.apostrophes.length > 0);
  // A file whose lists changed shape is refused: fewer than 10 phrases read.
  assert.throws(() => optOutLists(source.replace("OPT_OUT_PHRASES = [", "OPT_OUT_PHRASES = [];[")));
  const classify = readFileSync(CLASSIFY_CONSTANTS, "utf8");
  const messages = /\bCLASSIFY_THREAD_MESSAGES = (\d+);/.exec(classify)?.[1];
  assert.equal(Number(messages), CLASSIFY_THREAD_MESSAGES);
  const max = /\bCLASSIFY_TEXT_MAX = \{ reply: ([\d_]+), thread: ([\d_]+) \}/.exec(classify);
  assert.deepEqual(
    [max?.[1], max?.[2]].map((value) => Number(value?.replaceAll("_", ""))),
    [CLASSIFY_TEXT_MAX.reply, CLASSIFY_TEXT_MAX.thread],
  );
});

it("maps each golden line to a case, with the owner's class or beta's word only", () => {
  const dir = outside();
  const earlier = [
    {
      direction: "out",
      sent_by: "campaign",
      text: "Worth a short call?",
      at: "2026-11-05T09:00:00.000Z",
    },
    {
      direction: "in",
      sent_by: null,
      text: "Maybe, [first_name] here.",
      at: "2026-11-06T23:30:00.000Z",
    },
  ];
  const line = {
    person_sha256: "a".repeat(64),
    thread_sha256: "b".repeat(64),
    channel: "linkedin",
    label: "positive",
    labeled_at: "2026-11-11T08:00:00.000Z",
    received_at: "2026-11-10T07:00:00.000Z",
    text: "Yes, send the invite.",
    earlier,
    opt_out_matched: false,
    classification: {
      label: "interested",
      confidence: 0.9,
      is_suggested: false,
      origin: "model",
      prompt_version: 1,
    },
  };
  const lines = [
    { ...line, class_label: "interested" },
    { ...line, class_label: "opt_out", label: "not_positive", earlier: [] },
    "",
    { ...line, label: "not_positive", text: "x".repeat(9_000) },
    { ...line, class_label: null, earlier: Array.from({ length: 10 }, () => earlier[0]) },
  ];
  const file = join(dir, "reply-labels-2026-11-12.jsonl");
  writeFileSync(file, `${lines.map((l) => (l === "" ? "" : JSON.stringify(l))).join("\n")}\n`);
  const cases = goldenCases(readFileSync(file, "utf8"));
  assert.deepEqual(
    cases.map(({ name, expected }) => [name, expected]),
    [
      ["golden-1", { label: "interested" }],
      ["golden-2", { label: "opt_out" }],
      ["golden-4", { positive: false }],
      ["golden-5", { positive: true }],
    ],
  );
  assert.deepEqual(cases[0]?.input, {
    thread: [
      { from: "seller", day: "2026-11-05", text: "Worth a short call?" },
      { from: "lead", day: "2026-11-06", text: "Maybe, [first_name] here." },
    ],
    reply: { day: "2026-11-10", text: "Yes, send the invite." },
  });
  assert.deepEqual(cases[1]?.input.thread, []);
  const long = cases[2]?.input as { reply: { text: string } };
  assert.equal(long.reply.text.length, CLASSIFY_TEXT_MAX.reply);
  assert.equal((cases[3]?.input.thread as unknown[]).length, CLASSIFY_THREAD_MESSAGES);
  // A broken line is named by its number, never its text.
  writeFileSync(file, `${JSON.stringify(lines[0])}\n{"text":"SECRET-REPLY"}\n`);
  assert.throws(
    () => goldenCases(readFileSync(file, "utf8")),
    (error: Error) =>
      /^line 2 is not a line/.test(error.message) && !error.message.includes("SECRET"),
  );
});

it("refuses --cases without EVAL_LIVE=1, from inside the repository and for another task, and EVAL_LIVE=1 in the pipeline, each before any call", () => {
  const golden = join(outside(), "golden.jsonl");
  const line = {
    label: "positive",
    received_at: "2026-11-10T07:00:00.000Z",
    text: "Yes.",
    earlier: [],
  };
  writeFileSync(golden, `${JSON.stringify(line)}\n`);
  const inside = join(tmp, "golden.jsonl");
  writeFileSync(inside, `${JSON.stringify(line)}\n`);
  const run = (env: Record<string, string>, ...args: string[]) => {
    const { WHYTIDE_CI_LOCAL: _, ...base } = process.env;
    return spawnSync(process.execPath, ["evals/run.ts", ...args], {
      cwd: pkg,
      encoding: "utf8",
      env: { ...base, PROVIDER_LLM: "fake", EVAL_LIVE: "1", ...env },
    });
  };
  const refusals: [Record<string, string>, string[], RegExp][] = [
    [{ EVAL_LIVE: "0" }, [CLASSIFY, "--cases", golden], /^eval: --cases runs live only/m],
    [{}, [CLASSIFY, "--cases", inside], /^eval: --cases: the file is inside the repository/m],
    [
      {},
      [WRITE, "--cases", golden],
      /^eval: --cases adds the reply golden set to inbox\.classify-reply only/m,
    ],
    [{ WHYTIDE_CI_LOCAL: "1" }, [CLASSIFY], /^eval: EVAL_LIVE=1 is refused in the pipeline$/m],
    [{ WHYTIDE_CI_LOCAL: "1" }, [], /^eval: EVAL_LIVE=1 is refused in the pipeline$/m],
    // Past the golden checks, the fake is refused live: the file was read, still no call.
    [{}, [CLASSIFY, "--cases", golden], /^eval: EVAL_LIVE=1 runs on the model of PROVIDER_LLM/m],
  ];
  for (const [env, args, why] of refusals) {
    const refused = run(env, ...args);
    assert.equal(refused.status, 2, `${args.join(" ")}: ${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, why, args.join(" "));
    assert.doesNotMatch(refused.stdout, /^== /m, "no eval ran");
  }
});

it("keeps a golden run's record to names, counts and scores, with no text, input or reply", () => {
  const outcome = {
    status: "ok",
    output: { label: "interested", confidence: 0.9, returnDate: null },
    attempts: 1,
    failures: [],
  };
  const input = { thread: [], reply: { day: "2026-11-10", text: "REPLY-TEXT" } };
  const cases = [
    { name: "syn-a", score: { label: 1, positive_recall: 1 }, outcome },
    { name: "golden-1", score: { label: 1, positive_recall: 1 }, outcome, input },
    { name: "golden-3", score: { positive_precision: 0 }, outcome: { ...outcome, calls: [input] } },
  ];
  const checks = [
    { check: "positive_recall", threshold: 0.93, mean: 1, cases: 2, below: [], pass: true },
    {
      check: "positive_precision",
      threshold: 0.93,
      mean: 0.67,
      cases: 3,
      below: ["golden-3"],
      pass: false,
    },
  ];
  const report = {
    task: CLASSIFY,
    promptVersion: 1,
    vendor: "v",
    modelId: "m",
    checks,
    cases,
    pass: false,
  };
  const record = runRecord(report as unknown as EvalReport, "2026-11-13");
  assert.doesNotMatch(JSON.stringify(record), /REPLY-TEXT|"input"|"output"|"text"/);
  assert.deepEqual(record.counts, { cases: 3, golden: 2 });
  assert.deepEqual(
    record.cases.map((c) => c.name),
    ["syn-a", "golden-1", "golden-3"],
  );
  assert.deepEqual(record.checks, checks);
});

it("fails naming the injection cases when the writer's red-line gate is removed", () => {
  const run = evalRun(WRITE, "--dir", writerWithout("redLinesGate"));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}injection-red-lines +ok +1 /m);
  assert.match(run.stdout, /^ {2}first-message-injection +ok +1 /m);
  const both = "injection-red-lines, first-message-injection";
  assert.match(
    run.stdout,
    writerFailed(`fails_safe 0.67 under 1.00: ${both}; red_lines 0.94 under 1.00: ${both}`),
  );
});

it("fails naming the colleague cases when the writer's colleague-signal gate is removed", () => {
  const run = evalRun(WRITE, "--dir", writerWithout("colleagueSignalGate"));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}colleague-phrase-retry +ok +1 /m);
  assert.match(run.stdout, /^ {2}colleague-phrase-twice +ok +1 /m);
  const why = [
    "fails_safe 0.83 under 1.00: colleague-phrase-twice",
    "colleague_signal 0.83 under 1.00: colleague-phrase-retry, colleague-phrase-twice",
  ];
  assert.match(run.stdout, writerFailed(why.join("; ")));
});

it("fails naming the case whose text names a colleague, repeats 8 words or claims a reply", () => {
  const edits: Record<string, readonly [string, string]> = {
    "colleague-name": ["is no small thing", "is no small thing for Jordan Lee"],
    "follow-up-1-proof": [
      "a result that may interest you",
      "sales teams at companies like Quorvale often see this",
    ],
    "follow-up-2-comment": ["Femke, ", "Thanks for your reply. Femke, "],
  };
  const dir = copyOf(WRITE, `export * from "${scorerOf(WRITE)}";\n`, (cases) => {
    for (const { name, fake } of cases) {
      const [from, to] = edits[name] ?? [];
      const answer = fake[0];
      if (answer && from && to) answer.text = answer.text.replace(from, to);
    }
  });
  const run = evalRun(WRITE, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  for (const name of Object.keys(edits)) {
    assert.match(run.stdout, new RegExp(`^ {2}${name} +ok +1 `, "m"), name);
  }
  const why = [
    "colleague_signal 0.92 under 1.00: colleague-name",
    "no_repeat 0.92 under 1.00: follow-up-1-proof",
    "absent 0.83 under 1.00: follow-up-2-comment",
  ];
  assert.match(run.stdout, writerFailed(why.join("; ")));
});

it("fails naming the act case when the writer's signal-act gate is removed", () => {
  const run = evalRun(WRITE, "--dir", writerWithout("signalActGate"));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}v3-act-comment-retry +ok +1 /m);
  assert.match(run.stdout, writerFailed("signal_act 0.97 under 1.00: v3-act-comment-retry"));
});

it("fails naming the email cases its gates refuse once removed, a colleague named and an opening repeated", () => {
  const scorer = [
    `import * as scorer from "${scorerOf(EMAIL)}";`,
    "export const { score, thresholds } = scorer;",
    "const removed = [scorer.linksGate, scorer.subjectGate, scorer.signalActGate];",
    "export const gates = scorer.gates.filter((gate) => !removed.includes(gate));",
    "",
  ].join("\n");
  const edits: Record<string, readonly [string, string]> = {
    "pain-winter-follow-up": ["With checks", "With Rhys Morgan's checks"],
    "comment-breakdowns-follow-up": [
      "one result that may be useful for the winter months",
      "the true cost of a breakdown goes well past the repair",
    ],
  };
  const dir = copyOf(EMAIL, scorer, (cases) => {
    for (const { name, fake } of cases) {
      const [from, to] = edits[name] ?? [];
      const answer = fake[0];
      if (answer && from && to) answer.body = answer.body.replace(from, to);
    }
  });
  const run = evalRun(EMAIL, "--dir", dir);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  for (const name of ["reaction-speed-first", "pain-founder-first", "reaction-service-follow-up"]) {
    assert.match(run.stdout, new RegExp(`^ {2}${name} +ok +1 `, "m"), name);
  }
  const why = [
    "subject 0.95 under 1.00: reaction-service-follow-up",
    "links 0.90 under 1.00: pain-founder-first",
    "colleague_signal 0.95 under 1.00: pain-winter-follow-up",
    "signal_act 0.95 under 1.00: reaction-speed-first",
    "no_repeat 0.90 under 1.00: comment-breakdowns-follow-up",
  ];
  assert.match(run.stdout, failedLine(EMAIL, why.join("; ")));
});

it("fails naming the price case when the reply writer's grounding gate is removed", () => {
  const scorer = [
    `import * as scorer from "${scorerOf(REPLY)}";`,
    "export const { score, thresholds } = scorer;",
    "export const gates = scorer.gates.filter((gate) => gate !== scorer.groundingGate);",
    "",
  ].join("\n");
  const run = evalRun(REPLY, "--dir", copyOf(REPLY, scorer));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}brief-price-missing +ok +1 /m);
  const why =
    "grounding 0.88 under 1.00: brief-price-missing; absent 0.67 under 1.00: brief-price-missing";
  assert.match(run.stdout, failedLine(REPLY, why));
});

it("gives the email writer at least 10 synthetic leads, marked so, each with a first email and a follow-up", () => {
  type EmailCase = { input: { lead: unknown; step: { kind: string } }; expected: object };
  const cases: EmailCase[] = JSON.parse(readFileSync(join(evals, EMAIL, "cases.json"), "utf8"));
  assert.ok(cases.every(({ expected }) => "synthetic" in expected && expected.synthetic === true));
  const kinds = new Map<string, Set<string>>();
  for (const { input } of cases) {
    const lead = JSON.stringify(input.lead);
    kinds.set(lead, (kinds.get(lead) ?? new Set()).add(input.step.kind));
  }
  const both = [...kinds.values()].filter(
    (set) => set.has("email_first") && set.has("email_follow_up"),
  );
  assert.ok(both.length >= 10, `${both.length} leads with both emails`);
});

it("keeps the scorers' phrases equal to messaging's gates, read as text", () => {
  const gates = join(pkg, "..", "..", "modules", "messaging", "domain", "gates");
  const lists = [
    ["format.ts", "RED_LINES", RED_LINES],
    ["constants.ts", "COLLEAGUE_SIGNAL_PHRASES", COLLEAGUE_SIGNAL_PHRASES],
    ["constants.ts", "SIGNAL_ACT_PHRASES", SIGNAL_ACT_PHRASES],
  ] as const;
  for (const [file, name, copy] of lists) {
    const source = readFileSync(join(gates, file), "utf8");
    const module = phrasesIn(source, name);
    assert.ok(module.length >= 10, `${file}: ${name} has its phrases`);
    assert.deepEqual(sorted(copy), sorted(module), `${file}: ${name}`);
    // A phrase added to one side only is a difference.
    const added = source.replace(`${name} = [`, `${name} = [\n  "one side only",`);
    assert.notDeepEqual(sorted(copy), sorted(phrasesIn(added, name)), `${file}: one side only`);
  }
});

/** The strings of the array a TypeScript file declares as `name`, its comments aside. */
function phrasesIn(source: string, name: string): string[] {
  const list = new RegExp(`\\b${name} = \\[([^\\]]*)\\]`).exec(source)?.[1] ?? "";
  const strings = list.replace(/\/\/[^\n]*/g, "").match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
  return strings.map((literal) => JSON.parse(literal) as string);
}
const sorted = (list: readonly string[]) => [...list].sort();

it("keeps real addresses out of the case and run files, and every text out of a run's record", () => {
  const files = readdirSync(evals, { recursive: true, encoding: "utf8" }).filter((file) =>
    /(?:^|\/)(?:cases|runs\/[^/]+)\.json$/.test(file),
  );
  assert.ok(files.length >= 5);
  const reserved = /(?:^|\.)(?:example|test|invalid|localhost)$|^example\.(?:com|net|org)$/;
  for (const file of files) {
    const text = readFileSync(join(evals, file), "utf8").toLowerCase();
    const hosts = [
      ...text.matchAll(/\bhttps?:\/\/([^\s"/?#:]+)/g),
      ...text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g),
      ...text.matchAll(/\b((?:[\w-]+\.)+(?:com|net|org|io|ai|co|eu|de|nl|be|fr|uk))\b/g),
    ].map((match) => match[1] ?? "");
    for (const host of hosts) assert.match(host, reserved, `${file}: ${host}`);
  }

  const failures = [{ attempt: 1, reason: "gates", issues: [{ path: "text", message: "TEXT-1" }] }];
  const outcome = {
    status: "ok",
    output: { text: "TEXT-2" },
    attempts: 2,
    calls: ["TEXT-3"],
    failures,
  };
  const cases = [
    { name: "texts", score: { outcome: 0 }, outcome },
    { name: "thrown", score: {}, error: "TEXT-4 in a message" },
    { name: "coded", score: {}, error: "ai_budget_exceeded" },
  ];
  const record = runRecord(
    { task: "a.b", checks: [], cases } as unknown as EvalReport,
    "2026-10-27",
  );
  assert.doesNotMatch(JSON.stringify(record), /TEXT-/);
  assert.deepEqual(
    record.cases.map((c) => c.result),
    ["ok", "error", "ai_budget_exceeded"],
  );
});

it("runs the step when a file under an agent's folder changed since main, and only then", () => {
  const repo = mkdtempSync(join(tmp, "repo-"));
  const identity = ["-c", "user.name=Eval Test", "-c", "user.email=eval@example.test"];
  const git = (...args: string[]) => {
    const run = spawnSync("git", [...identity, "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
  };
  const change = (file: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "a change\n");
  };
  const commit = (file: string) => {
    change(file);
    git("add", "-A");
    git("commit", "-q", "-m", file);
  };
  git("init", "-q", "-b", "main");
  commit("README.md");
  git("switch", "-q", "-c", "task");
  commit("core/modules/qualification/domain/assess/checks.ts");
  assert.equal(evalsChanged(repo), false);
  change("core/modules/qualification/agents/assess-fit/prompt.v1.md");
  assert.equal(evalsChanged(repo), true, "untracked");
  commit("core/modules/qualification/agents/assess-fit/prompt.v1.md");
  assert.equal(evalsChanged(repo), true, "committed");
});
