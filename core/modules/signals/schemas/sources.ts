// The bodies and answers of the sources routes (README.md "API"), from which the api host builds the
// OpenAPI document. The module checks a source's kind against the registry and its config against the
// kind's schema, so the body takes any kind and any object here.
import { z } from "zod";

/** One of our ids by its shape, `<prefix>_<ULID>`, whatever the prefix. */
const anId = z.string().regex(/^[a-z][a-z0-9]{1,7}_[0-9A-HJKMNP-TV-Z]{26}$/);
const label = z.string().trim().min(1).max(100);

export const createSourceBody = z.strictObject({
  kind: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()),
  label,
  /** One of the workspace's sender accounts, connected or not: a run checks that it is connected. */
  senderAccountId: anId,
});
export type CreateSourceBody = z.infer<typeof createSourceBody>;

export const updateSourceBody = z.strictObject({
  enabled: z.boolean().optional(),
  label: label.optional(),
});
export type UpdateSourceBody = z.infer<typeof updateSourceBody>;

export const sourceParams = z.strictObject({ id: z.string().min(1).max(64) });
export const runParams = sourceParams.extend({ runId: z.string().min(1).max(64) });

export const sourceResponse = z.strictObject({
  id: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  label: z.string(),
  senderAccountId: z.string(),
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
