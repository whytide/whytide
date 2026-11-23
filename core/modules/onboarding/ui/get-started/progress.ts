// The prompt's progress (README "The prompt at sign-in"), plain functions of what the api answered:
// where the Company Knowledge's run stands, where the ICP's automatic draft stands then (icp's README
// "The automatic draft"), and the steps that show both. No import of the web: the module's build
// compiles this file, and the slot and the card read it.
import { CONTENT_FIELDS, type ContentField } from "../../domain/fields.ts";
import type { CompanyKnowledgeResponse } from "../../schemas/company-knowledge.ts";
import { STUCK_MS } from "../company/constants.ts";
import { ICP_STUCK_MS } from "./constants.ts";

type Knowledge = CompanyKnowledgeResponse;
/** icp's targeting and its row's last change, as `GET …/icp` answers them. */
export type Icp = {
  readonly titles: readonly string[];
  readonly seniorities: readonly string[];
  readonly industries: readonly string[];
  readonly sizeRanges: readonly string[];
  readonly countries: readonly string[];
  readonly mustHaves: string;
  readonly disqualifiers: string;
  readonly updatedAt: string;
};
/** icp's latest draft, as `GET …/icp/draft` answers it. */
export type IcpDraft = { readonly status: "none" | "drafting" | "drafted" | "failed" };
/** The ICP when the run started: whether it had targeting, and when its row last changed. */
export type IcpStart = { readonly set: boolean; readonly updatedAt: string };

/** The Company Knowledge for the prompt: the form, the run, its end. */
export type Stage = "form" | "running" | "stuck" | "failed" | "review" | "saved";
/** The ICP once the Company Knowledge is saved: still to come, or how it ended. */
export type Outcome = "waiting" | "saved" | "set" | "review" | "failed" | "stuck";
export const STEPS = ["reading", "drafting", "saved", "icp_building", "icp_saved"] as const;
export type Step = (typeof STEPS)[number];
export type StepState = "done" | "active" | "next" | "stopped";

/** Whether a content field holds a value: a text, or a list with an item. */
export function hasContent(record: Pick<Knowledge, ContentField>): boolean {
  return CONTENT_FIELDS.some((field) => record[field].length > 0);
}

/** icp's rule (its domain/rules.ts): a list with a value, or a must-have or a disqualifier. */
export function hasTargeting(icp: Icp): boolean {
  const lists = [icp.titles, icp.seniorities, icp.industries, icp.sizeRanges, icp.countries];
  return lists.some((list) => list.length > 0) || icp.mustHaves !== "" || icp.disqualifiers !== "";
}

/**
 * Where the record stands: a run fetching or drafting, stuck once it has not changed for twenty
 * minutes (the Company screen's rule); once this card `started` one, or found one failed, the
 * failure, the draft waiting for review (a run without the automatic accept), or saved; else the form.
 */
export function stageOf(record: Knowledge, started: boolean, now = Date.now()): Stage {
  const status = record.fetchStatus;
  if (status === "fetching" || status === "fetched") {
    return now - Date.parse(record.updatedAt) > STUCK_MS ? "stuck" : "running";
  }
  if (!started) return "form";
  if (status === "failed") return "failed";
  if (status === "drafted" && record.pendingDraft !== null) return "review";
  return status === "drafted" && hasContent(record) ? "saved" : "form";
}

/**
 * Where the ICP stands once the Company Knowledge is saved (`since`): set already when the run
 * started; saved once it has targeting; a draft waiting for review; a draft that failed after the
 * start (an earlier failure stays until the automatic draft starts); else still to come, `none`
 * until icp's subscriber runs, then `drafting`, stuck after ten minutes without a change.
 */
export function outcomeOf(
  start: IcpStart | undefined,
  icp: Icp | undefined,
  draft: IcpDraft | undefined,
  since: string,
  now = Date.now(),
): Outcome {
  if (start?.set) return "set";
  if (icp !== undefined && hasTargeting(icp)) return "saved";
  if (draft?.status === "drafted") return "review";
  const at = icp === undefined ? 0 : Date.parse(icp.updatedAt);
  const changed = start === undefined || at > Date.parse(start.updatedAt);
  if (draft?.status === "failed" && changed) return "failed";
  const last = Math.max(Date.parse(since), at);
  return now - last > ICP_STUCK_MS ? "stuck" : "waiting";
}

/** The steps and where each stands; an ICP set already has no step of its own. */
export function stepsOf(record: Knowledge, stage: Stage, outcome: Outcome): [Step, StepState][] {
  const saved = stage === "saved";
  const fetching = record.fetchStatus === "fetching";
  const icp: StepState =
    outcome === "waiting"
      ? "active"
      : outcome === "saved" || outcome === "review"
        ? "done"
        : "stopped";
  const states: Record<Step, StepState> = {
    reading: saved || !fetching ? "done" : "active",
    drafting: saved ? "done" : fetching ? "next" : "active",
    saved: saved ? "done" : "next",
    icp_building: saved ? icp : "next",
    icp_saved: saved && outcome === "saved" ? "done" : "next",
  };
  const shown = outcome === "set" ? STEPS.filter((step) => !step.startsWith("icp_")) : STEPS;
  return shown.map((step) => [step, states[step]]);
}
