// The gates (domain/gates/, docs/security.md "The gates") on the dossier fixture's lead, in pure
// code: case tables for grounding, lenient on accents, case and spacing and strict on what no fact
// holds; the placeholders, lengths and red lines of criterion 3; the plan's facts_used against the
// writer's blocks, which carry the newest three events and no link, source or hash. The colleague
// gate's phrases, word boundaries, case and names, and checkText per channel and kind against the
// worktree's database, which holds the lead's colleagues (beta-p3-020).
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { assembleDossier } from "../domain/dossier/assemble.ts";
import { writerBlocks } from "../domain/drafts/blocks.ts";
import { checkText } from "../domain/gates/check-text.ts";
import { colleagueIssues, plural } from "../domain/gates/colleague.ts";
import { COLLEAGUE_SIGNAL_PHRASES } from "../domain/gates/constants.ts";
import { extractEntities, groundingIssues } from "../domain/gates/grounding.ts";
import {
  checkPlan,
  checkWrittenText,
  factIdsOf,
  issuesOf,
  type Limits,
  limitsOf,
} from "../domain/gates/index.ts";
import type { GateIssue } from "../schemas/writer.ts";
import { inputs } from "./fixtures/dossier/inputs.ts";
import { COLLEAGUE, run, seed, seedColleague } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));

const dossier = assembleDossier(inputs);
const grounding = (text: string): string[] =>
  groundingIssues(text, dossier).flatMap((issue) =>
    issue.gate === "grounding" ? issue.entity : [],
  );
const issues = (text: string, limits: Limits = limitsOf("linkedin_message")): GateIssue[] =>
  issuesOf(checkWrittenText(text, dossier, limits, []));
/** The words of each colleague issue of the text. */
const hits = (text: string, colleagues: Parameters<typeof colleagueIssues>[1] = []): string[] =>
  colleagueIssues(text, colleagues).flatMap((issue) =>
    issue.gate === "colleague_signal" ? issue.phrase : [],
  );

test("grounding passes what the lead's facts hold, accents, case, spacing and possessives aside", () => {
  const grounded = [
    "Ines, Signal Radar helps Acme reach warm leads.",
    "INES, does ACME use signal radar?",
    "Inês, your team in Lisbon, Portugal.",
    "Signal  Radar and Lead Review, for Acme's sales teams.",
    "Northwind booked 40% more meetings in a quarter, used by 120 sales teams of 51-200 people.",
    "Your comment on October 2 stood out; so did the one of 2 Oct, 2026-10-01 and Friday.",
    "Thanks, Ines. Saw your comment on LinkedIn about B2B leads. Best, Sam.",
    "Head of Data at Acme, in Software Development.",
    "Acme's Head of Data, Ines.",
  ];
  for (const text of grounded) assert.deepEqual(grounding(text), [], text);
});

test("grounding fails, naming it, each name, company, tool, number or date no fact holds", () => {
  const ungrounded: [string, string[]][] = [
    ["Ines, teams like Globex use Signal Radar.", ["Globex"]],
    ["Ines Duarte, a question.", ["Ines Duarte"]],
    ["Northwind booked 35% more meetings.", ["35"]],
    // Digits of no figure: an event's month, a post's id.
    ["Northwind booked 10% more meetings.", ["10"]],
    ["Ines, about your post 7250000000000000002.", ["7250000000000000002"]],
    ["Your comment on October 5 stood out.", ["October 5"]],
    ["Do you pair Signal Radar with HubSpot? HubSpot users do.", ["HubSpot"]],
    ["See you on Monday in Madrid.", ["Monday", "Madrid"]],
  ];
  for (const [text, entities] of ungrounded) assert.deepEqual(grounding(text), entities, text);
});

test("extractEntities finds the dates, then the numbers, then the names; a possessive ends a name", () => {
  const cases: [string, string[]][] = [
    ["Ines, Signal Radar helps Acme reach warm leads.", ["Ines", "Signal Radar", "Acme"]],
    ["Acme's Head of Data, Ines Duarte.", ["Acme", "Head of Data", "Ines Duarte"]],
    ["Northwind booked 40% more meetings, 1,900 of them.", ["#40", "#1,900", "Northwind"]],
    [
      "See you on October 2, 2026, 2 Oct or 2026-10-01, on Friday.",
      ["@2026-10-01", "@October 2, 2026", "@2 Oct", "@Friday"],
    ],
    ["Thanks, Ines. Saw your post on LinkedIn about B2B leads.", ["Ines"]],
    ["May I ask how your team works?", []],
  ];
  const mark = { date: "@", number: "#", name: "" };
  for (const [text, expected] of cases) {
    const found = extractEntities(text).map((entity) => mark[entity.kind] + entity.text);
    assert.deepEqual(found, expected, text);
  }
});

test("criterion 3: a placeholder, a note of 201, a message of 1,901 and a red line fail their gates; 120 fails, 200 passes", () => {
  const note = limitsOf("linkedin_note");
  assert.deepEqual(note, { min: 1, max: 200 });
  const ok = (length: number) => `Ines, ${"so ".repeat(length)}`.slice(0, length - 1).concat("?");
  assert.deepEqual(issues(ok(200), note), []);
  assert.deepEqual(issues(ok(201), note), [{ gate: "length", length: 201, min: 1, max: 200 }]);
  assert.deepEqual(issues(ok(1_901)), [{ gate: "length", length: 1_901, min: 150, max: 300 }]);
  assert.deepEqual(issues(ok(120)), [{ gate: "length", length: 120, min: 150, max: 300 }]);
  assert.deepEqual(issues(ok(200)), []);

  const placeholders: [string, string][] = [
    ["Hi {{first_name}}, a question?", "{{first_name}}"],
    ["Hi Ines, how does [Company] do it?", "[Company]"],
    ["Hi Ines, how does {company} do it?", "{company}"],
    ["Hi Ines, how does <company> do it?", "<company>"],
    ["Hi Ines, how does INSERT do it?", "INSERT"],
  ];
  for (const [text, placeholder] of placeholders) {
    const found: GateIssue[] = issues(text, note).filter(({ gate }) => gate === "placeholders");
    assert.deepEqual(found, [{ gate: "placeholders", placeholder }], text);
  }
  const redLines: [string, string][] = [
    ["Ines, as we discussed, a question?", "as we discussed"],
    ["As we discussed, Ines: a question?", "as we discussed"],
    ["Re: your comment, Ines.", "Re:"],
    ["Ines, last chance to see it.", "last chance"],
    ["Ines, don’t miss out.", "don't miss out"],
  ];
  for (const [text, phrase] of redLines) {
    assert.deepEqual(issues(text, note), [{ gate: "red_lines", phrase }], text);
  }
});

test("the plan may cite the facts of the writer's blocks only: the newest three events, no link, no source, no hash", () => {
  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00.000Z`);
  const event = (day: number) => ({
    id: `sev_0${day}`,
    occurredAt: at(day),
    evidence: {
      id: `evd_0${day}`,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:72500000000000000${day}`,
      excerpt: null,
      commentText: null,
      reaction: "like",
    },
  });
  const four = assembleDossier({ ...inputs, events: [1, 2, 3, 4].map(event) });
  const blocks = writerBlocks(four);
  assert.deepEqual(
    blocks.why_now.map(({ at }) => Object.values(at)),
    [[at(4).toISOString()], [at(3).toISOString()], [at(2).toISOString()]],
  );
  const sent = JSON.stringify(blocks);
  for (const absent of ["linkedin.com", "sourceRef", "persons/", four.dossierHash]) {
    assert.ok(!sent.includes(absent), absent);
  }
  assert.deepEqual(blocks.lead.firstName, { f_8: "Ines" });

  const known = factIdsOf(writerBlocks(dossier));
  const plan = { angle: "signal_comment", cta: "question" } as const;
  assert.deepEqual(checkPlan({ ...plan, factIds: ["f_8", "f_18"] }, known), [
    { gate: "facts_used", issues: [] },
  ]);
  // f_16 is the post's link, which the planner never reads.
  assert.deepEqual(issuesOf(checkPlan({ ...plan, factIds: ["f_8", "f_16", "f_99"] }, known)), [
    { gate: "facts_used", factId: "f_16" },
    { gate: "facts_used", factId: "f_99" },
  ]);
});

test("the colleague gate refuses each phrase in any case, with any marks around it, its last word also plural; never its words inside longer words", () => {
  assert.deepEqual(["colleague", "team", "company", "boss", "coach", "day"].map(plural), [
    "colleagues",
    "teams",
    "companies",
    "bosses",
    "coaches",
    "days",
  ]);
  for (const phrase of COLLEAGUE_SIGNAL_PHRASES) {
    const many = phrase.replace(/\S+$/u, (last) => plural(last));
    for (const said of [phrase, phrase.toUpperCase(), many, many.toUpperCase()]) {
      const texts = [said, `“${said}”!`, `(${said}),`, `Hi—${said}?`, `Ines.\n${said}: liked it`];
      for (const text of texts) assert.deepEqual(hits(text), [said], text);
      assert.deepEqual(hits(`x${said} ${said}x`), [], said);
    }
  }
  const inside = [
    "your colleagueship",
    "yourcolleague",
    "your managerial style",
    "someone on your teamwork",
    "people at your companywide call",
  ];
  for (const text of inside) assert.deepEqual(hits(text), [], text);
  assert.deepEqual(hits("Your colleague's post, then your colleague's reply."), ["Your colleague"]);
  assert.deepEqual(hits("your co-workers and your coworker"), ["your co-workers", "your coworker"]);
});

test("the colleague gate refuses a colleague's first and last name together, as the text wrote them, accents and case aside; never a first or a last name alone, nor a colleague without both", () => {
  const colleagues = [
    { firstName: "Maria", lastName: "Lopez" },
    { firstName: "José", lastName: "Núñez García" },
    { firstName: "Sam", lastName: null },
    { firstName: null, lastName: "Writer" },
  ];
  const cases: [string, string[]][] = [
    ["Ines, Maria Lopez said hi.", ["Maria Lopez"]],
    ["INES, MARIA LOPEZ said hi.", ["MARIA LOPEZ"]],
    ["Saw maria lopez's post.", ["maria lopez"]],
    ["Jose Nunez-Garcia liked it.", ["Jose Nunez-Garcia"]],
    ["Maria said hi.", []],
    ["Lopez said hi.", []],
    ["Maria Lopezz said hi.", []],
    ["Sam liked it; Writer too.", []],
  ];
  for (const [text, expected] of cases) assert.deepEqual(hits(text, colleagues), expected, text);
});

test("checkText per channel and kind: a step's note may be empty, a lead's note and any message may not, each up to its hard limit; trimmed; placeholders, red lines and colleagues, in the gates' order; never grounding", async () => {
  const { workspaceId, personId } = await seed();
  await seedColleague(workspaceId, personId);
  const check = (text: string, channel: "linkedin_note" | "linkedin_message", kind: string) =>
    run(workspaceId, () =>
      checkText(text, { personId, channel, kind: kind as "lead_draft" | "outbound_step" }),
    );
  const length = (n: number, min: number, max: number) => ({
    ok: false,
    issues: [{ gate: "length", length: n, min, max }],
  });
  const pass = { ok: true };
  const note = (n: number) => "Ines, a note?".padEnd(n, ".");
  const cases: [string, "linkedin_note" | "linkedin_message", string, object][] = [
    ["", "linkedin_note", "outbound_step", pass],
    ["   \n ", "linkedin_note", "outbound_step", pass],
    [`  ${note(200)}  `, "linkedin_note", "outbound_step", pass],
    [note(201), "linkedin_note", "outbound_step", length(201, 0, 200)],
    ["", "linkedin_note", "lead_draft", length(0, 1, 200)],
    [note(200), "linkedin_note", "lead_draft", pass],
    ["  ", "linkedin_message", "outbound_step", length(0, 1, 1_900)],
    ["", "linkedin_message", "lead_draft", length(0, 1, 1_900)],
    [note(1_900), "linkedin_message", "outbound_step", pass],
    [note(1_901), "linkedin_message", "lead_draft", length(1_901, 1, 1_900)],
    // Grounding is the writer's: a name no fact holds passes here.
    ["Ines, Globex uses it. Does Acme?", "linkedin_message", "outbound_step", pass],
    ["Ines Duarte, does your team use it?", "linkedin_note", "outbound_step", pass],
    [`${COLLEAGUE.firstName}, does your team use it?`, "linkedin_note", "lead_draft", pass],
  ];
  for (const [text, channel, kind, expected] of cases) {
    assert.deepEqual(await check(text, channel, kind), expected, `${channel} ${kind} ${text}`);
  }
  const every = "Hi {{first_name}}, as we discussed, Maria Lopez and your teammates liked it.";
  assert.deepEqual(await check(every, "linkedin_message", "outbound_step"), {
    ok: false,
    issues: [
      { gate: "placeholders", placeholder: "{{first_name}}" },
      { gate: "red_lines", phrase: "as we discussed" },
      { gate: "colleague_signal", phrase: "Maria Lopez" },
      { gate: "colleague_signal", phrase: "your teammates" },
    ],
  });
  await assert.rejects(
    run(workspaceId, () =>
      checkText("Hi", { personId: "per_gone", channel: "linkedin_note", kind: "lead_draft" }),
    ),
    { code: "person_not_found" },
  );
});
