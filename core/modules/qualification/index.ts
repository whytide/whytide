// The public interface of qualification (README.md): the hard filters, which the signal run
// (alpha-p8-030) and the batch (alpha-p6-040) apply before any model sees a person, prepared once per
// run or batch, and the title rule, for signals' read order (title-check-ai); the assessment of a
// person who passed them, and the erasure of its rows; the score of an assessment with its why, and
// the why of a lead the filters stopped; the closed lists of the assessment; the batch's start and
// event (alpha-p6-040), the re-score's route and start; the lead page's snapshot read and its route
// (alpha-p6-060); the leads a span's assessments qualified, for credits' cost counter
// (alpha-p10-010); the why bullets' source of the grounding sample, which loading this file defines
// (alpha-p10-050); the registries; the signal reader's registry and the leads' priorities, for
// campaigns' plans (gamma-p5-060). Nothing else in this module is importable from outside it
// (docs/rules/coding.md §2).

export { QualificationApi as api } from "./api/rescore.controller.ts";
export {
  type AssessContext,
  type AssessResult,
  assessPerson,
  erasePerson,
} from "./domain/assess/assess-person.ts";
export { whySample } from "./domain/export/grounding.ts";
export {
  applyHardFilters,
  HARD_FILTER_REASONS,
  type HardFilterCompany,
  type HardFilterDetail,
  type HardFilterIcp,
  type HardFilterPerson,
  type HardFilterReason,
  type HardFilterResult,
  type PreparedHardFilters,
  prepareHardFilters,
} from "./domain/hard-filters/index.ts";
export { icpTitleTokens, titleFits } from "./domain/hard-filters/titles.ts";
export {
  INTENT_CLASSES,
  INTENT_KINDS,
  INTENT_ROLES,
  type IntentClass,
  type IntentKind,
  type IntentRole,
} from "./domain/intent/constants.ts";
export { type LeadPriority, leadPriorities } from "./domain/intent/store.ts";
export { requestRescore } from "./domain/rescore.ts";
export { countQualified } from "./domain/score/count-qualified.ts";
export {
  getSnapshot,
  type Snapshot,
  type SnapshotVerdict,
} from "./domain/score/get-snapshot.ts";
export { type ScoreResult, scoreSnapshot } from "./domain/score/score-snapshot.ts";
export {
  defineSignalReader,
  type IntentInput,
  type SignalReader,
} from "./domain/signal-reader.ts";
export { buildWhy, type WhyInput, type WhyKey } from "./domain/why/index.ts";
export { errors } from "./errors.ts";
export { batchStart, events, rescoreStart } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { prices } from "./prices.ts";
export {
  CRITERIA,
  type Criterion,
  type CriterionVerdict,
  DISQUALIFIERS,
  type Disqualifier,
  VERDICTS,
  type Verdict,
} from "./schemas/assess-fit.ts";
