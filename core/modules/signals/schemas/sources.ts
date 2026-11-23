// The bodies and answers of the sources routes (README.md "API"), from which the api host builds the
// OpenAPI document. The module checks a source's kind against the registry and its config against the
// kind's schema, so the body takes any kind and any object here.
import { z } from "zod";

/** One of our ids by its shape, `<prefix>_<ULID>`, whatever the prefix. */
const anId = z.string().regex(/^[a-z][a-z0-9]{1,7}_[0-9A-HJKMNP-TV-Z]{26}$/);
/** One of the workspace's sender accounts, connected or not: a run checks that it is connected. */
export const senderAccountId = anId;
const label = z.string().trim().min(1).max(100);

export const createSourceBody = z.strictObject({
  kind: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()),
  label,
  /**
   * One of the workspace's sender accounts, connected or not: a run checks that it is connected.
   * Required for a kind that reads through a LinkedIn account and refused for one that does not
   * (web_research), both by the module, `signal_sender_account_invalid` naming the field.
   */
  senderAccountId: senderAccountId.optional(),
});
export type CreateSourceBody = z.infer<typeof createSourceBody>;

export const updateSourceBody = z.strictObject({
  enabled: z.boolean().optional(),
  label: label.optional(),
  /** A new config, for a kind that allows it (web_research); the kind's schema reads it. */
  config: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSourceBody = z.infer<typeof updateSourceBody>;

export const sourceParams = z.strictObject({ id: z.string().min(1).max(64) });
export const runParams = sourceParams.extend({ runId: z.string().min(1).max(64) });

export const sourceResponse = z.strictObject({
  id: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  label: z.string(),
  /** The LinkedIn account it reads through; null for a source of a kind that reads through none. */
  senderAccountId: z.string().nullable(),
  enabled: z.boolean(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  lastRunAt: z.iso.datetime().nullable(),
  /** Its kind's fire times after its last run, all three before the first; none while disabled. */
  fireTimes: z.array(z.iso.datetime()),
  /** The first of them; null while it is disabled or once its last fire time has run. */
  nextRunAt: z.iso.datetime().nullable(),
  /** One of its runs is `running` or `waiting`: run now answers 409 until it ends. */
  runOpen: z.boolean(),
  /** That run, a running one before a waiting one, and when its stop was asked; null when none is open. */
  openRun: z
    .strictObject({
      id: z.string(),
      status: z.enum(["running", "waiting"]),
      stopRequestedAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  /**
   * `daily`: it also runs once a day, inside its share of the account's reads (gamma-p5-040);
   * `research`: it runs every `everyDays` days, in an active agent (gamma-wr-030).
   */
  cadence: z.enum(["daily", "research"]).nullable(),
  /** The days between two runs of a `research` source (SIGNALS_RESEARCH_EVERY_DAYS); null for any other. */
  everyDays: z.number().int().nullable(),
  /** Its last run, the one at `lastRunAt`, ended done at its read budget (`counts.budget_reached`). */
  lastRunBudgetReached: z.boolean(),
  /** The CSV import that created it, its file's name; null for one added from the form. */
  sourceImport: z.strictObject({ id: z.string(), fileName: z.string() }).nullable(),
  /** The agent that holds it, playbooks', with its name; null for a source in no agent. */
  playbook: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
});
export type SourceResponse = z.infer<typeof sourceResponse>;
export const sourceListResponse = z.strictObject({ sources: z.array(sourceResponse) });

export const runResponse = z.strictObject({
  id: z.string(),
  sourceId: z.string(),
  status: z.enum(["scheduled", "running", "waiting", "done", "failed", "cancelled"]),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  counts: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  /** When a stop was asked; the run ends `cancelled` (fix-run-stop). */
  stopRequestedAt: z.iso.datetime().nullable(),
});
export type RunResponse = z.infer<typeof runResponse>;
export const runListResponse = z.strictObject({ runs: z.array(runResponse) });

/**
 * The last plan of a research source (gamma-wr-041): its words by language, the ids of its source
 * types (the screen names them with their labels) and when it was made; `plan` null before any.
 */
export const researchPlanResponse = z.strictObject({
  plan: z
    .strictObject({
      id: z.string(),
      runId: z.string(),
      madeAt: z.iso.datetime(),
      words: z.array(z.strictObject({ language: z.string(), words: z.array(z.string()) })),
      placeIds: z.array(z.string()),
    })
    .nullable(),
});
export type ResearchPlanResponse = z.infer<typeof researchPlanResponse>;
