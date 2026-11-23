// The noise rules (gamma-p5-030; README.md "Processing"): recruiters, job seekers and competitors'
// staff by the staged headline before the read, each off as the audience asks; a triaged run's
// competitor rule alone; and after the read the competitor's rule only, as the assessment judges
// recruiters and job seekers (signals-triage-ai).
import assert from "node:assert/strict";
import { test } from "node:test";
import { competitorsOf, noiseRules } from "../domain/process/noise.ts";

const audience = { titles: ["Head of Sales", "VP Marketing"], mustHaves: "B2B SaaS" };
const acme = { name: "Acme Labs", pageUrl: "https://www.linkedin.com/company/acme-labs/" };
const profile = { headline: "Building things", companyName: "Initech" };

test("a recruiter term in the headline drops it, as whole words in any case, plurals too", () => {
  const rules = noiseRules(audience, []);
  const matched = [
    "Technical Recruiter at Initech",
    "RECRUITERS wanted",
    "Talent   Acquisition Partner",
    "Headhunter | Executive search",
    "Senior sourcer",
    "Staffing agency owner",
  ];
  for (const text of matched) assert.equal(rules.headline(text), "dropped_recruiter", text);
  const missed = ["Recruitment marketing", "Sourcery engineer", "Restaffing lead", ""];
  for (const text of missed) assert.equal(rules.headline(text), null, text);
});

test("a job-seeker phrase in the headline drops it", () => {
  const rules = noiseRules(audience, []);
  const matched = [
    "Open to work | Product designer",
    "#OpenToWork",
    "Looking for opportunities in SaaS",
    "Seeking new opportunities",
    "Engineer, looking for a new role",
  ];
  for (const text of matched) assert.equal(rules.headline(text), "dropped_job_seeker", text);
  const missed = ["Opening doors to work", "#opentoworkshops", "Looking for co-founders"];
  for (const text of missed) assert.equal(rules.headline(text), null, text);
});

test("a competitor's name after at or @ in the headline drops it; elsewhere it does not", () => {
  const rules = noiseRules(audience, [acme]);
  const matched = [
    "Sales at ACME labs",
    "Engineer @Acme Labs",
    "Engineer @ acme  labs | Ex-Initech",
  ];
  for (const text of matched) assert.equal(rules.headline(text), "dropped_competitor", text);
  const missed = ["Acme Labs alumni", "at Acme Laboratories", "Chat Acme Labs", "Sales at Acme"];
  for (const text of missed) assert.equal(rules.headline(text), null, text);
  assert.equal(noiseRules(audience, [{ name: "A", pageUrl: null }]).headline("CTO at A"), null);
});

test("each rule is off as the audience asks; the competitor's never is", () => {
  const recruiters = noiseRules({ titles: ["Recruiter"], mustHaves: "" }, [acme]);
  assert.equal(recruiters.headline("Technical Recruiter"), null);
  assert.equal(recruiters.headline("Open to work"), "dropped_job_seeker");
  assert.equal(recruiters.headline("Recruiter at Acme Labs"), "dropped_competitor");
  const talent = noiseRules({ titles: ["Head of Talent Acquisition"], mustHaves: "" }, []);
  assert.equal(talent.headline("Staffing lead"), null);
  const seekers = noiseRules({ titles: [], mustHaves: "Helps job seekers land roles" }, []);
  assert.equal(seekers.headline("#OpenToWork"), null);
  assert.equal(seekers.headline("Recruiter"), "dropped_recruiter");
  const open = noiseRules({ titles: ["Candidates open to work"], mustHaves: "" }, []);
  assert.equal(open.headline("Open to work"), null);
});

test("a triaged run's headline rule is the competitor's alone: no recruiter or job-seeker term drops", () => {
  const rules = noiseRules(audience, [acme]);
  for (const text of ["Technical Recruiter at Initech", "#OpenToWork", "Staffing agency owner"]) {
    assert.equal(rules.competitor(text), null, text);
  }
  assert.equal(rules.competitor("Sales at ACME labs"), "dropped_competitor");
  assert.equal(rules.competitor("Recruiter @ Acme Labs"), "dropped_competitor");
});

test("after the read: the company's name or page, then the headline; no recruiter or job-seeker term drops (signals-triage-ai)", () => {
  const rules = noiseRules(audience, [acme]);
  assert.equal(rules.profile(profile), null);
  assert.equal(rules.profile({ ...profile, headline: "Talent Acquisition Lead" }), null);
  assert.equal(rules.profile({ ...profile, headline: "#opentowork" }), null);
  assert.equal(rules.profile({ ...profile, companyName: " acme  LABS " }), "dropped_competitor");
  const page = { ...profile, companyUrl: "https://uk.linkedin.com/company/ACME-LABS" };
  assert.equal(rules.profile(page), "dropped_competitor");
  assert.equal(rules.profile({ ...profile, headline: "PM @ Acme Labs" }), "dropped_competitor");
  const other = { ...profile, companyName: "Acme", companyUrl: "https://acme-labs.example" };
  assert.equal(rules.profile(other), null);
  assert.equal(rules.profile({ ...profile, companyName: "" }), null);
  const recruiterThere = { ...profile, headline: "Recruiter", companyName: "Acme Labs" };
  assert.equal(rules.profile(recruiterThere), "dropped_competitor");
});

test("the competitors are read from the sources' configs, and a config without either is skipped", () => {
  const page = "https://linkedin.com/company/1234";
  const configs = [
    { companyName: "Acme Labs", companyUrl: page },
    { companyUrl: page },
    { companyName: "  " },
    { companyName: 3 },
    null,
    "Acme",
  ];
  assert.deepEqual(competitorsOf(configs), [
    { name: "Acme Labs", pageUrl: page },
    { name: "", pageUrl: page },
  ]);
  const rules = noiseRules(audience, competitorsOf([{ companyUrl: page }]));
  const byPage = { ...profile, companyUrl: "https://www.linkedin.com/company/1234/" };
  assert.equal(rules.profile(byPage), "dropped_competitor");
  assert.equal(rules.headline("CEO at Initech"), null);
});
