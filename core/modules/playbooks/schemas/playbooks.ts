// The requests and answers of the agents' routes (README "Routes"), from which the api host validates
// the input and builds the OpenAPI document. The lengths, counts and the sources' form are checked
// here (400 validation_failed); the audience, the limits and each source by the commands, with their
// own codes. Nothing here reads settings.ts: the document is the same whatever the environment sets
// (README "Settings").
import { z } from "zod";
import {
  AGENTS_PER_WORKSPACE,
  ID_MAX,
  MAX_CHECKED_SOURCES,
  PAUSED_REASONS,
  PLAYBOOK_NAME_MAX,
  PLAYBOOK_STATUSES,
  SOURCE_CODES,
  SOURCE_ID_LIST_PATTERN,
  SOURCE_ID_PATTERN,
  SOURCES_PER_AGENT,
} from "../domain/constants.ts";

const name = z.string().trim().min(1).max(PLAYBOOK_NAME_MAX);
const icpId = z.string().min(1).max(ID_MAX);
const sourceId = z.string().regex(SOURCE_ID_PATTERN);

/** The agent a route's path names: one of the workspace's, else playbook_not_found. */
export const playbookParams = z.strictObject({ playbookId: z.string().min(1).max(ID_MAX) });

export const createPlaybookBody = z.strictObject({
  name: name.describe(`Trimmed, 1 to ${PLAYBOOK_NAME_MAX} characters`),
  icpId: icpId.describe(
    "An audience of the workspace (icp's GET …/icp/audiences), which no live agent has",
  ),
});
export type CreatePlaybookBody = z.infer<typeof createPlaybookBody>;

export const updatePlaybookBody = z.strictObject({
  name: name.optional(),
  icpId: icpId.optional().describe("Another audience, checked as a create checks it"),
  status: z
    .enum(PLAYBOOK_STATUSES)
    .optional()
    .describe(
      "active and paused go back and forth; archived is final and frees the sources. A pause is the member's; an agent paused because its owner left the workspace is resumed by that owner alone",
    ),
});
export type UpdatePlaybookBody = z.infer<typeof updatePlaybookBody>;

export const sourcesBody = z.strictObject({
  sourceIds: z
    .array(sourceId)
    .describe(
      `The agent's whole set, at most the list's limits.sources (${SOURCES_PER_AGENT.default} by default; more is playbook_sources_limit), each a source of signals' (src_…) read through the owner's own account and held by no other agent`,
    ),
});
export type SourcesBody = z.infer<typeof sourcesBody>;

export const checkQuery = z.strictObject({
  ids: z
    .string()
    .regex(SOURCE_ID_LIST_PATTERN)
    .optional()
    .describe(`Up to ${MAX_CHECKED_SOURCES} source ids, comma-separated`),
});
export type CheckQuery = z.infer<typeof checkQuery>;

const playbook = {
  id: z.string(),
  name: z.string(),
  icpId: z.string().describe("icp's audience"),
  ownerUserId: z.string().describe("The member who created it"),
  status: z.enum(PLAYBOOK_STATUSES),
  pausedReason: z
    .enum(PAUSED_REASONS)
    .nullable()
    .describe(
      "Why it is paused, null unless it is: user, a member's pause; member_removed, its owner left the workspace",
    ),
  createdAt: z.iso.datetime(),
};

export const playbookListResponse = z.strictObject({
  playbooks: z
    .array(z.strictObject({ ...playbook, sourceCount: z.number().int() }))
    .describe("The live agents first, then the archived ones, oldest first"),
  limits: z
    .strictObject({
      agents: z
        .number()
        .int()
        .describe(
          `The most agents not archived in a workspace, ${AGENTS_PER_WORKSPACE.default} by default`,
        ),
      sources: z
        .number()
        .int()
        .describe(`The most sources one agent holds, ${SOURCES_PER_AGENT.default} by default`),
    })
    .describe("The limits the server is configured with, which the screens show"),
});
export type PlaybookListResponse = z.infer<typeof playbookListResponse>;

export const playbookResponse = z.strictObject({
  ...playbook,
  sourceIds: z.array(z.string()).describe("The sources it holds, oldest link first"),
});
export type PlaybookResponse = z.infer<typeof playbookResponse>;

export const checkResponse = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        sourceId: z.string(),
        usable: z.boolean(),
        code: z
          .enum(SOURCE_CODES)
          .nullable()
          .describe(
            "Why the agent cannot hold it, as PUT …/sources would answer; null when usable",
          ),
        heldBy: z
          .string()
          .nullable()
          .describe(
            "The other agent that holds it, whose name the screen shows; null when none does",
          ),
      }),
    )
    .describe("Each id asked, once, in the order asked"),
});
export type CheckResponse = z.infer<typeof checkResponse>;
