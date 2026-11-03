// The receiver tests' fixture (tests/receiver.test.ts, tests/safety/receiver-once.test.ts): a
// connected account of a new workspace with an outreach row, what the deliveries left, and commits
// that fail after the publish. The test file calls withTestDb() and the use…Client hooks first.
import { randomUUID } from "node:crypto";
import { asRole } from "@whytide/db/testing";
import { createOrganizationWithWorkspace } from "@whytide/tenancy/testing";
import { createConnectedAccount, createOutreach } from "../../testing/index.ts";

/** The member the account invited. */
export const MEMBER = "member-ines";

/** A connected account of a new workspace, its reference, and its outreach row (for MEMBER). */
export async function seeded(
  row: { providerMemberRef?: string; providerChatRef?: string } = { providerMemberRef: MEMBER },
) {
  const { workspace } = await createOrganizationWithWorkspace();
  const ref = `fake-account-${randomUUID()}`;
  const { id: accountId } = await createConnectedAccount(workspace.id, { providerAccountRef: ref });
  const outreach = await createOutreach(workspace.id, { senderAccountId: accountId, ...row });
  return { workspaceId: workspace.id, ref, accountId, outreach };
}

/** The receipts, and the names of the workspace's events, sorted. */
export async function recorded(workspaceId: string) {
  const app = asRole("app");
  const events = await app.outboxEntry.findMany({ where: { workspaceId } });
  const receipts = await app.linkedinEventReceipt.count();
  return { receipts, events: events.map((row) => row.eventName).sort() };
}

/** While fn runs, a transaction that writes an outbox row fails at its commit, after the publish. */
export async function failingCommits(fn: () => Promise<void>): Promise<void> {
  const owner = asRole("owner");
  await owner.$executeRawUnsafe(
    "CREATE FUNCTION fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the commit fails'; END $$",
  );
  await owner.$executeRawUnsafe(
    "CREATE CONSTRAINT TRIGGER fail_at_commit AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_commit()",
  );
  try {
    await fn();
  } finally {
    await owner.$executeRawUnsafe("DROP TRIGGER fail_at_commit ON outbox");
    await owner.$executeRawUnsafe("DROP FUNCTION fail_commit()");
  }
}
