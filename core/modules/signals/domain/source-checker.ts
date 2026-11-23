// signals' source checker (README.md "Decided here"; gamma-p5-045), which playbooks asks before it
// links a source to an agent, since it cannot read signals' table: registered as signals loads
// (register-checker.ts). In the caller's tenant run, so another workspace's source is not found and
// its account never named. It writes nothing; playbooks decides the refusal from its answers. A source
// with no sender account, a research source (gamma-wr-030), is found with no reading account and its
// creator as the reading owner.
import { tenantClient } from "@whytide/db";
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { currentTenant, isAppError } from "@whytide/platform";
import type { SourceCheck } from "@whytide/playbooks";

/** linkedin's account read, by id: its owner. */
export type FindAccount = (accountId: string) => Promise<{ readonly ownerUserId: string }>;

/**
 * One answer per id, in their order. A source of the run's workspace is found, with the sender
 * account it reads through and that account's owner, each account read once; an account linkedin no
 * longer finds leaves both null, which playbooks refuses as playbook_source_wrong_owner; a source with
 * no account answers no account and its creator (`created_by`) as the owner. An id of no
 * source of the workspace, another workspace's included, is not found, both null. The rows are read
 * FOR SHARE until the run commits: a delete of one at the same time waits and then detaches the new
 * link, or goes first and leaves the id not found.
 */
export async function checkSources(
  sourceIds: readonly string[],
  find: FindAccount = findSenderAccount,
): Promise<SourceCheck[]> {
  const ids = [...new Set(sourceIds)].filter((id) => id !== "");
  const { workspaceId } = currentTenant();
  type Row = { id: string; senderAccountId: string | null; createdBy: string };
  const rows =
    ids.length === 0
      ? []
      : await tenantClient.$queryRaw<Row[]>`
          SELECT id, sender_account_id AS "senderAccountId", created_by AS "createdBy"
          FROM signal_sources
          WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}) ORDER BY id FOR SHARE`;
  const owners = new Map<string, string | null>();
  for (const { senderAccountId } of rows) {
    if (senderAccountId !== null && !owners.has(senderAccountId))
      owners.set(senderAccountId, await ownerOf(senderAccountId, find));
  }
  const found = new Map(rows.map((row) => [row.id, row]));
  return sourceIds.map((sourceId): SourceCheck => {
    const row = found.get(sourceId);
    if (row === undefined) {
      return { sourceId, found: false, readingAccountId: null, readingOwnerUserId: null };
    }
    const { senderAccountId, createdBy } = row;
    if (senderAccountId === null) {
      return { sourceId, found: true, readingAccountId: null, readingOwnerUserId: createdBy };
    }
    const owner = owners.get(senderAccountId) ?? null;
    const readingAccountId = owner === null ? null : senderAccountId;
    return { sourceId, found: true, readingAccountId, readingOwnerUserId: owner };
  });
}

/** The account's owner; null when linkedin no longer finds it (sender_account_not_found). */
async function ownerOf(accountId: string, find: FindAccount): Promise<string | null> {
  try {
    return (await find(accountId)).ownerUserId;
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}
