// playbooks' test helpers (README.md "Testing"), `@whytide/playbooks/testing`, in test files only:
// createPlaybook writes an agent straight to the table, as the commands leave one, for playbooks',
// signals', campaigns' and the web's e2e tests; on the client given, else on the one
// usePlaybooksClient set, else on asRole("app") of @whytide/db/testing, so the test file calls
// withTestDb() first. playbooks opens no run of its own (every command runs in its caller's), so the
// factory's client is the only one. useSourceChecker puts a test's fake checker in place, and its
// function, called after the test, takes it out. pauseRemovedMember is the body of the subscriber to
// tenancy.member_removed, for the web's e2e api, which runs no worker (gamma-p6-075).
import type { TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import type { PausedReason, PlaybookStatus } from "../domain/constants.ts";
import { ids } from "../ids.ts";

export { pauseRemovedMember } from "../domain/removed.ts";
export { useSourceChecker } from "../domain/source-checker.ts";

type Client = Pick<TenantClient, "playbook" | "playbookSource">;
let given: Client | undefined;

/** The client createPlaybook writes on when none is given; undefined restores asRole("app"). */
export function usePlaybooksClient(client: Client | undefined): void {
  given = client;
}

/** An agent's columns as a test seeds them; each has a default the table's CHECK accepts. */
export type SeededPlaybook = {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly ownerUserId: string;
  /** "Agent" unless given. */
  readonly name?: string;
  /** active unless given; archived sets archived_at. */
  readonly status?: PlaybookStatus;
  /** A paused agent's reason, `user` unless given; null for any other status (the CHECK). */
  readonly pausedReason?: PausedReason;
  /** The sources it holds, none unless given. */
  readonly sourceIds?: readonly string[];
};

/** An agent written straight to the tables, with its sources. Its id. */
export async function createPlaybook(
  input: SeededPlaybook,
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const { workspaceId, icpId, ownerUserId, name = "Agent", status = "active" } = input;
  const id = newId(ids.playbook);
  const archivedAt = status === "archived" ? new Date() : null;
  const pausedReason = status === "paused" ? (input.pausedReason ?? "user") : null;
  const row = { id, workspaceId, name, icpId, ownerUserId, status, pausedReason, archivedAt };
  await client.playbook.create({ data: { ...row, createdBy: ownerUserId } });
  for (const sourceId of input.sourceIds ?? []) {
    const link = { id: newId(ids.playbook_source), workspaceId, playbookId: id, sourceId };
    await client.playbookSource.create({ data: link });
  }
  return id;
}
