// The gates (domain/gates/, docs/security.md "The gates") on the dossier fixture's lead, in pure
// code: case tables for grounding, lenient on accents, case and spacing and strict on what no fact
// holds; the placeholders, lengths and red lines of criterion 3; the plan's facts_used against the
// writer's blocks, which carry the newest three events and no link, source or hash. The colleague
// gate's phrases, word boundaries, case and names, and checkText per channel and kind against the
// worktree's database, which holds the lead's colleagues (beta-p3-020). The message policies
// (gamma-p3-070): the act phrases on every channel, an email's subject, a first email's links and
// length, and the near duplicates of a mailbox, in pure code and in checkText.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { assembleDossier } from "../domain/dossier/assemble.ts";
import { writerBlocks } from "../domain/drafts/blocks.ts";
import { checkText, type TextCheckInput } from "../domain/gates/check-text.ts";
import { colleagueIssues, plural } from "../domain/gates/colleague.ts";
import { COLLEAGUE_SIGNAL_PHRASES, SIGNAL_ACT_PHRASES } from "../domain/gates/constants.ts";
import { extractEntities, groundingIssues } from "../domain/gates/grounding.ts";
import {
  checkPlan,
  checkWrittenText,
  factIdsOf,
  issuesOf,
  type Limits,
  limitsOf,
} from "../domain/gates/index.ts";
import { nearDuplicateIssues, similarity, subjectIssues } from "../domain/gates/policies.ts";
import { CHANNELS, type GateIssue, type GateName } from "../schemas/writer.ts";
import { createStepDraft } from "../testing/index.ts";
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

const SUBJECT = "Warm leads at Acme";
/** A follow-up's body that passes every gate. */
const BODY =
  "Ines, one more thought for Acme: Signal Radar reads public posts every day and sends the warm leads to Lead Review before they go cold.";
const TOPIC =
  "Ines, the post on leads that go cold before sales calls them stood out. Does Acme see it?";
/** The issues of one gate. */
const only = (gate: GateName, found: readonly GateIssue[]) =>
  found.filter((issue) => issue.gate === gate);
const email = (text: string, subject: string | null = SUBJECT, first = true) =>
  issuesOf(checkWrittenText(text, dossier, limitsOf("email"), [], { subject, first }));
const near = (similarity: number) => [{ gate: "near_duplicate", similarity }];

test("signal_act refuses each act phrase on every channel, in any case, with marks around it, as the text wrote it, in the writer's gates and in checkText, an email's subject too; a text naming the post's topic passes", async () => {
  const { workspaceId, personId } = await seed();
  for (const channel of CHANNELS) {
    const later = channel === "email" ? { subject: null, first: false } : undefined;
    const written = (text: string) =>
      only("signal_act", issuesOf(checkWrittenText(text, dossier, limitsOf(channel), [], later)));
    const kind = channel === "email" ? { stepKind: "email_follow_up" as const } : {};
    const checked = async (text: string) => {
      const target = { personId, channel, kind: "outbound_step" as const, ...kind };
      const result = await run(workspaceId, () => checkText(text, target));
      return result.ok ? [] : only("signal_act", result.issues);
    };
    for (const phrase of SIGNAL_ACT_PHRASES) {
      for (const said of [phrase, phrase.toUpperCase()]) {
        const text = `Ines, “${said}”! The post on warm leads stood out.`;
        const issue = [{ gate: "signal_act", phrase: said }];
        assert.deepEqual(
          [written(text), await checked(text)],
          [issue, issue],
          `${channel} ${said}`,
        );
      }
    }
    assert.deepEqual([written(TOPIC), await checked(TOPIC)], [[], []], channel);
    assert.deepEqual(written("Ines, your commentary on leads stood out."), [], channel);
  }
  const act = (phrase: string) => ({ gate: "signal_act", phrase });
  assert.deepEqual(only("signal_act", email(TOPIC, "Saw you liked it")), [act("Saw you liked")]);
  assert.deepEqual(only("signal_act", email("Ines, you reacted.", "You reacted")), [
    act("You reacted"),
    act("you reacted"),
  ]);
  assert.deepEqual(only("signal_act", email("Ines, you reacted.", "you reacted")), [
    act("you reacted"),
  ]);
});

test("subject: a first email's, trimmed, has 1 to 6 words and at most 60 characters, on one line, with no Re:, Fw: or Fwd: in any case; a follow-up has none", () => {
  const problems = (subject: string | null, first: boolean) =>
    subjectIssues(subject, first).flatMap((issue) =>
      issue.gate === "subject" ? issue.problem : [],
    );
  const cases: [string | null, boolean, string[]][] = [
    [SUBJECT, true, []],
    ["  One two three four five six  ", true, []],
    ["x".repeat(60), true, []],
    ["One two three four five six seven", true, ["too_long"]],
    ["x".repeat(61), true, ["too_long"]],
    [null, true, ["missing"]],
    [" \n ", true, ["missing"]],
    ["Re: warm leads", true, ["prefix"]],
    ["FW : warm leads", true, ["prefix"]],
    ["fwd:warm leads", true, ["prefix"]],
    ["Warm leads\nat Acme", true, ["line_break"]],
    ["Regarding warm leads", true, []],
    ["RE: one two three four five six seven\r\n", true, ["too_long", "prefix"]],
    [null, false, []],
    ["  ", false, []],
    ["Warm leads", false, ["not_allowed"]],
  ];
  for (const [subject, first, expected] of cases) {
    assert.deepEqual(problems(subject, first), expected, `${first} ${subject}`);
  }
  assert.deepEqual(only("subject", email(TOPIC, "Re: warm leads")), [
    { gate: "subject", problem: "prefix" },
  ]);
  // Alpha's and beta's text gates read the subject as the body.
  const onSubject: [string, GateName, GateIssue][] = [
    ["Re: warm leads", "red_lines", { gate: "red_lines", phrase: "Re:" }],
    ["Hi {{first_name}}", "placeholders", { gate: "placeholders", placeholder: "{{first_name}}" }],
    ["Leads at Globex", "grounding", { gate: "grounding", entity: "Globex" }],
    [
      "Your colleague liked it",
      "colleague_signal",
      { gate: "colleague_signal", phrase: "Your colleague" },
    ],
  ];
  for (const [said, gate, issue] of onSubject) {
    assert.deepEqual(only(gate, email(TOPIC, said)), [issue], said);
  }
});

test("links: a first email's subject or body with an http(s) address, www., an email address or a bare domain fails, each link as written, once; e.g., U.S. and figures pass; a follow-up and a LinkedIn text may hold one", () => {
  const links = (body: string, subject = SUBJECT) => only("links", email(body, subject));
  const link = (...found: string[]) =>
    found.map((said): GateIssue => ({ gate: "links", link: said }));
  const cases: [string, GateIssue[]][] = [
    ["See https://acme.io/demo?ref=1.", link("https://acme.io/demo?ref=1")],
    ["See http://acme.io, then reply.", link("http://acme.io")],
    ["Visit www.signalradar.com/tour!", link("www.signalradar.com/tour")],
    ["Write to sam@signalradar.com.", link("sam@signalradar.com")],
    ["Our site is signalradar.io.", link("signalradar.io")],
    ["Try app.signal-radar.co.uk (free).", link("app.signal-radar.co.uk")],
    ["Built on Node.js, twice: Node.js.", link("Node.js")],
    ["E.g. teams in the U.S. and the U.K. reach warm leads, i.e. sooner.", []],
    ["Northwind booked 40% more meetings. 2.5 times more.", []],
  ];
  for (const [body, expected] of cases) assert.deepEqual(links(body), expected, body);
  assert.deepEqual(links("Ines, a question.", "See acme.io"), link("acme.io"));
  assert.deepEqual(links("More at acme.io.", "acme.io"), link("acme.io"));
  const text = "More at https://acme.io and www.acme.io.";
  assert.deepEqual(
    [only("links", email(text, null, false)), only("links", issues(text))],
    [[], []],
  );
});

test("an email's length: the writer's body 50 to 120 words, its issue in words; a typed one 1 character to the hard limit, in characters; checkText's subject and its refusals off an email", async () => {
  const words = (n: number) => Array.from({ length: n }, () => "lead").join(" ");
  const counted = (n: number) => ({ gate: "length", length: n, min: 50, max: 120, unit: "words" });
  assert.deepEqual(
    [49, 50, 120, 121].map((n) => only("length", email(words(n)))),
    [[counted(49)], [], [], [counted(121)]],
  );
  assert.deepEqual(only("length", email(`${words(25)}\n\n ${words(25)}`)), []);

  const { workspaceId, personId } = await seed();
  const check = (text: string, target: Partial<TextCheckInput> = {}) =>
    run(workspaceId, () =>
      checkText(text, {
        personId,
        channel: "email",
        kind: "lead_draft",
        subject: SUBJECT,
        ...target,
      }),
    );
  const typed = (n: number) => ({
    ok: false,
    issues: [{ gate: "length", length: n, min: 1, max: 1_900, unit: "characters" }],
  });
  assert.deepEqual(await check("Ines?"), { ok: true });
  assert.deepEqual([await check("  "), await check("x".repeat(1_901))], [typed(0), typed(1_901)]);
  const subject = (problem: string) => ({ ok: false, issues: [{ gate: "subject", problem }] });
  assert.deepEqual(await check("Ines?", { subject: null }), subject("missing"));
  const later = { stepKind: "email_follow_up", subject: null } as const;
  assert.deepEqual(await check("More at acme.io?", later), { ok: true });
  assert.deepEqual(await check("Ines?", { ...later, subject: "Hi" }), subject("not_allowed"));
  const invalid = (field: string) => ({
    code: "messaging_input_invalid",
    details: { fields: [field] },
  });
  const linkedin = { channel: "linkedin_message", subject: null } as const;
  await assert.rejects(check("Ines?", { ...linkedin, subject: "Hi" }), invalid("subject"));
  await assert.rejects(check("Ines?", { ...linkedin, mailboxId: "mbx_1" }), invalid("mailboxId"));
  await assert.rejects(
    check("Ines?", { ...linkedin, stepKind: "email_first" }),
    invalid("stepKind"),
  );
  await assert.rejects(check("Ines?", { stepKind: "first_message" }), invalid("stepKind"));
});

test("near_duplicate: the highest Jaccard similarity of word 3-shingles, from 0.8, with two decimals and never the other text; below 0.8 passes", () => {
  // 18 words, 16 runs; four more words add four runs (16 / 20), five add five (16 / 21).
  const base =
    "Ines, leads that go cold before sales calls them cost data teams like Acme a week of pipeline";
  const at = `${base} every single quarter, Ines.`;
  const below = `${base} every single quarter here, sadly.`;
  assert.deepEqual(nearDuplicateIssues(at, [base]), near(0.8));
  assert.deepEqual(nearDuplicateIssues(below, [base]), []);
  assert.deepEqual(nearDuplicateIssues(base.toUpperCase(), [TOPIC, base]), near(1));
  // 19 shared runs of 22: the highest of the others, rounded.
  assert.deepEqual(nearDuplicateIssues(at, [TOPIC, below, base]), near(0.86));
  assert.deepEqual([nearDuplicateIssues(base, []), similarity(new Set(), new Set())], [[], 0]);
});

test("near_duplicate in checkText: a step's email against the other drafts of its mailbox with a body, made or approved in the last 24 hours, never the draft itself; another mailbox's, another workspace's or one 25 hours old passes", async () => {
  const { workspaceId, personId } = await seed();
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const step = (stepExecutionId: string, mailboxId: string, columns: object = {}) =>
    createStepDraft({
      workspaceId,
      personId,
      stepExecutionId,
      stepKey: "email_2",
      mailboxId,
      text: BODY,
      ...columns,
    });
  const check = (mailboxId: string, draftId?: string) =>
    run(workspaceId, () =>
      checkText(BODY, {
        personId,
        channel: "email",
        kind: "outbound_step",
        stepKind: "email_follow_up",
        mailboxId,
        ...(draftId && { draftId }),
      }),
    );
  const duplicate = { ok: false, issues: near(1) };
  await step("sx_now", "mbx_now");
  await step("sx_edited", "mbx_edited", { text: "Ines, a question?", editedText: BODY });
  await step("sx_approved", "mbx_approved", { createdAt: hoursAgo(25), status: "approved" });
  const own = await step("sx_own", "mbx_own");
  await step("sx_old", "mbx_old", { createdAt: hoursAgo(25) });
  await step("sx_empty", "mbx_empty", { status: "failed", text: null });
  const theirs = { workspaceId: "wsp_other", personId, stepExecutionId: "sx_theirs" };
  await createStepDraft({ ...theirs, stepKey: "email_2", mailboxId: "mbx_theirs", text: BODY });
  for (const mailbox of ["mbx_now", "mbx_edited", "mbx_approved"]) {
    assert.deepEqual(await check(mailbox), duplicate, mailbox);
  }
  for (const mailbox of ["mbx_old", "mbx_empty", "mbx_theirs", "mbx_none"]) {
    assert.deepEqual(await check(mailbox), { ok: true }, mailbox);
  }
  assert.deepEqual(await check("mbx_own", own), { ok: true });
});
