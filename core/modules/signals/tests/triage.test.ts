// The triage's pure parts (signals-triage-ai; README.md "Triage"): the batch as the model reads it,
// its schemas and its gate, the triage's answer as decisions and the read order, and the rules that
// decide a batch the triage could not answer, as a run before it decides them all.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noiseRules } from "../domain/process/noise.ts";
import { decisionsGate } from "../domain/triage/checks.ts";
import { batchOf, byRules, byTriage, type Decided, type Staged } from "../domain/triage/triage.ts";
import {
  type TriageEngagersOutput,
  triageEngagersInput,
  triageEngagersOutput,
} from "../schemas/triage-engagers.ts";

const icp = {
  titles: ["Revenue Operations Manager", "Agency Owner"],
  seniorities: ["manager" as const],
  industries: ["Software"],
  mustHaves: "B2B SaaS",
};
let made = 0;
const staged = (reaction: string, headline: string, name = "Dana Okafor"): Staged => {
  made += 1;
  const id = `cand_${made}`;
  return { id, profileUrl: `https://www.linkedin.com/in/${id}`, name, headline, reaction };
};
const decision = (index: number, kind: "skip" | "read_first" | "read", code?: string) =>
  ({ index, decision: kind, code: code ?? null }) as TriageEngagersOutput["decisions"][number];
/** A decision's ids: the dropped with their count, then each rank. */
const idsOf = ({ dropped, ranks }: Decided) => ({
  dropped: Object.fromEntries(dropped),
  ranks: ranks.map((rank) => rank.map(({ id }) => id)),
});

test("the batch: the ICP's targeting, then the candidates indexed from 1 in the staged order, a like and a repost reactions, each headline scrubbed with its name; never a name, a profile URL or an id", () => {
  const batch = [
    staged("author", "Dana Okafor | RevOps & GTM Lead at acme.io"),
    staged("like", "Founder, XYZ Staffing, lee@xyz.example", "Lee Park"),
    staged("repost", "Ops lead, call +44 20 7946 0958", "Sam Roe"),
    staged("comment", "Barista", "Ann Li"),
  ];
  const input = batchOf(icp, batch);
  assert.deepEqual(input, {
    icp: { ...icp, seniorities: ["manager"] },
    candidates: [
      { index: 1, role: "author", headline: "[name] [name] | RevOps & GTM Lead at [link]" },
      { index: 2, role: "reaction", headline: "Founder, XYZ Staffing, [email]" },
      { index: 3, role: "reaction", headline: "Ops lead, call [phone]" },
      { index: 4, role: "comment", headline: "Barista" },
    ],
  });
  assert.equal(triageEngagersInput.safeParse(input).success, true);
  const sent = JSON.stringify(input);
  for (const value of ["Dana", "Okafor", "Lee Park", "Sam Roe", "cand_", "linkedin.com"]) {
    assert.ok(!sent.includes(value), `the batch holds ${value}`);
  }
});

test("the schemas: 25 candidates at most, a decision and a code off their lists refused", () => {
  const many = Array.from({ length: 26 }, () => staged("like", "Engineer"));
  assert.equal(triageEngagersInput.safeParse(batchOf(icp, many)).success, false);
  assert.equal(triageEngagersInput.safeParse(batchOf(icp, many.slice(1))).success, true);
  const answer = (decisions: unknown[]) => triageEngagersOutput.safeParse({ decisions }).success;
  assert.equal(answer([{ index: 1, decision: "skip", code: "recruiter" }]), true);
  assert.equal(answer([{ index: 1, decision: "drop", code: null }]), false);
  assert.equal(answer([{ index: 1, decision: "skip", code: "agency_or_consultant" }]), false);
  assert.equal(answer([{ index: 26, decision: "read", code: null }]), false);
});

test("the gate: each candidate decided exactly once, no other index, and a code exactly for a skip", () => {
  const input = batchOf(icp, [staged("like", "Recruiter"), staged("like", "Barista")]);
  const gate = (...decisions: TriageEngagersOutput["decisions"]) =>
    decisionsGate({ decisions }, input).issues.map(({ message }) => message);
  assert.deepEqual(gate(decision(1, "skip", "recruiter"), decision(2, "read")), []);
  assert.deepEqual(gate(decision(1, "read"), decision(1, "read_first")), [
    "candidate 1: 2 decisions, one expected",
    "candidate 2: 0 decisions, one expected",
  ]);
  assert.deepEqual(gate(decision(1, "skip"), decision(2, "read", "job_seeker")), [
    "candidate 1: a skip needs its code",
    "candidate 2: a code only for a skip",
  ]);
  assert.deepEqual(gate(decision(1, "read"), decision(2, "read"), decision(3, "read")), [
    "candidate 3: not in the input",
  ]);
  assert.equal(decisionsGate({ decisions: [decision(1, "read")] }, input).gate, "decisions");
});

test("the triage's answer: a skip dropped as dropped_triage, a commenter's too; authors and commenters first, then read_first, then read, the staged order within each", () => {
  const batch = [
    staged("like", "Barista"),
    staged("like", "RevOps & GTM Lead"),
    staged("comment", "Technical Recruiter"),
    staged("like", "Founder, XYZ Staffing"),
    staged("author", "Chef"),
    staged("repost", "#OpenToWork"),
    staged("comment", "Head of Sales"),
  ];
  const [barista, revops, recruiter, founder, author, seeker, commenter] = batch.map(
    ({ id }) => id,
  );
  const output = {
    decisions: [
      ...[decision(1, "read"), decision(2, "read_first"), decision(3, "skip", "recruiter")],
      ...[decision(4, "read_first"), decision(5, "read"), decision(6, "skip", "job_seeker")],
      decision(7, "read_first"),
    ],
  };
  assert.deepEqual(idsOf(byTriage(batch, output)), {
    dropped: { [recruiter as string]: "dropped_triage", [seeker as string]: "dropped_triage" },
    ranks: [[author, commenter], [revops, founder], [barista]],
  });
});

test("the rules, for a batch the triage could not answer: the recruiter and job-seeker terms drop with their reasons, an agency's founder too; the rest in the title rule's ranks, which miss a combined title", () => {
  const batch = [
    staged("like", "Barista"),
    staged("like", "Revenue Operations Manager at Initech"),
    staged("like", "Technical Recruiter"),
    staged("comment", "#OpenToWork"),
    staged("author", "Chef"),
    staged("like", "Founder, XYZ Staffing"),
    staged("like", "RevOps & GTM Lead"),
  ];
  const [barista, manager, recruiter, seeker, author, founder, revops] = batch.map(({ id }) => id);
  const decided = byRules({ icp, noise: noiseRules(icp, []), staged: batch });
  assert.deepEqual(idsOf(decided), {
    dropped: {
      [recruiter as string]: "dropped_recruiter",
      [seeker as string]: "dropped_job_seeker",
      [founder as string]: "dropped_recruiter",
    },
    ranks: [[author], [manager], [barista, revops]],
  });
  const recruiting = { ...icp, titles: ["Recruiter"] };
  const kept = byRules({ icp: recruiting, noise: noiseRules(recruiting, []), staged: batch });
  assert.equal(kept.dropped.size, 1);
});
