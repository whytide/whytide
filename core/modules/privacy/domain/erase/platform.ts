// The person's traces in the platform's tables (README.md "Erasers", docs/security.md), which no module
// owns and the platform, which cannot import the database package, cannot erase: an event of the outbox
// names a person by id in `personId`, `person_id` in linkedin's snake_case events, or in a `personIds`
// list, delivered events staying in the table; an idempotency record keeps an endpoint's answer, a
// draft's with its person's id, for a day or more.
// Erased here, in the script's run, through the tenant client (the coordinator's decision of
// 2026-10-27 for the outbox).
import { type Prisma, tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";

type Listing = { readonly personIds: readonly string[] } & Record<string, unknown>;

/**
 * Deletes the workspace's events that name the person in `personId` or `person_id`, takes the person
 * out of the `personIds` lists that hold it, deleting an event whose list is left empty, and deletes
 * the idempotency records whose answer holds the person's id. The rows deleted or changed, by table.
 */
export async function erasePlatformRows(
  personId: string,
): Promise<{ outbox: number; idempotency_records: number }> {
  const named = await tenantClient.outboxEntry.deleteMany({
    where: {
      OR: ["personId", "person_id"].map((key) => ({ payload: { path: [key], equals: personId } })),
    },
  });
  const listing = await tenantClient.outboxEntry.findMany({
    where: { payload: { path: ["personIds"], array_contains: [personId] } },
    select: { id: true, payload: true },
  });
  for (const { id, payload } of listing) {
    const { personIds, ...rest } = payload as Listing;
    const left = personIds.filter((listed) => listed !== personId);
    if (left.length === 0) await tenantClient.outboxEntry.delete({ where: { id } });
    else {
      const data = { payload: { ...rest, personIds: left } as Prisma.InputJsonObject };
      await tenantClient.outboxEntry.update({ where: { id }, data });
    }
  }
  // An answer is any JSON: the id is looked for as a string anywhere in it.
  const { workspaceId } = currentTenant();
  const answers = await tenantClient.$executeRaw`
    DELETE FROM idempotency_records
    WHERE workspace_id = ${workspaceId}
      AND strpos(response_body::text, ${JSON.stringify(personId)}) > 0`;
  return { outbox: named.count + listing.length, idempotency_records: answers };
}
