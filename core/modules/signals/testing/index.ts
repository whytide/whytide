// signals' test factories (README.md "Testing"), `@whytide/signals/testing`, for tests only: a source,
// a run, and a person's event with its evidence, written on asRole("app") of @whytide/db/testing, so
// the test file calls withTestDb() first, or on the client given (the web's e2e api seeds the runs
// and the evidence of its database so). useSignalsClient points the create's own run at the test's
// client, and shortLinks.get, which a test replaces with mock.method, is a short link's request.
import type { PrismaClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import type { SignalEvent } from "../domain/evidence.ts";
import type { SignalRun, SignalRunStatus, SignalSource } from "../domain/sources.ts";
import { ids } from "../ids.ts";

export { useClient as useSignalsClient } from "../domain/client.ts";
export { shortLinks } from "../sources/post_engagers/post-url.ts";

const POST_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000009";

/** An enabled post_engagers source with the label, its sender account named by an id alone. */
export function createSignalSource(
  input: { workspaceId: string; label: string },
  client: PrismaClient = asRole("app"),
): Promise<SignalSource> {
  const { workspaceId, label } = input;
  return client.signalSource.create({
    data: {
      id: newId(ids.signal_source),
      workspaceId,
      kind: "post_engagers",
      config: { postUrl: POST_URL },
      label,
      senderAccountId: "sac_test",
      createdBy: "usr_test",
    },
  });
}

/** A run of the source, `scheduled` and never started unless the input says otherwise. */
export function createSignalRun(
  input: {
    workspaceId: string;
    sourceId: string;
    status?: SignalRunStatus;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    counts?: Record<string, number>;
    error?: string | null;
  },
  client: PrismaClient = asRole("app"),
): Promise<SignalRun> {
  const {
    status = "scheduled",
    startedAt = null,
    finishedAt = null,
    counts = {},
    error = null,
  } = input;
  const { workspaceId, sourceId } = input;
  return client.signalRun.create({
    data: {
      id: newId(ids.signal_run),
      workspaceId,
      sourceId,
      status,
      startedAt,
      finishedAt,
      counts,
      error,
    },
  });
}

/**
 * The person's engagement with a post, with its evidence: a like, or a comment with `commentText`,
 * unless `reaction` says otherwise; no source unless `sourceId` names one, no run unless `runId`
 * does; `occurredAt` now unless given. With `reducedAt`, reduced as alpha-p10-020 leaves it: no
 * excerpt or comment.
 */
export async function createSignalEvent(
  input: {
    workspaceId: string;
    personId: string;
    occurredAt?: Date;
    commentText?: string;
    reaction?: "like" | "comment" | "repost";
    sourceId?: string;
    runId?: string;
    author?: string;
    reducedAt?: Date;
  },
  client: PrismaClient = asRole("app"),
): Promise<SignalEvent> {
  const { workspaceId, personId, occurredAt = new Date(), sourceId = null, runId = null } = input;
  const { author = "Test Engager", reducedAt = null } = input;
  const commentText = reducedAt === null ? (input.commentText ?? null) : null;
  const reaction = input.reaction ?? (input.commentText === undefined ? "like" : "comment");
  const id = newId(ids.signal_event);
  const dedupeKey = `test:${id}`;
  const kind = "post_engagement";
  const event = await client.signalEvent.create({
    data: { id, workspaceId, personId, sourceId, runId, kind, dedupeKey, occurredAt },
  });
  const evidence = await client.evidence.create({
    data: {
      id: newId(ids.evidence),
      workspaceId,
      eventId: id,
      url: POST_URL,
      excerpt: commentText,
      commentText,
      reaction,
      author,
      capturedAt: occurredAt,
      reducedAt,
    },
  });
  return { ...event, evidence };
}
