// The countries' backfill (README "The place list", gamma-en-075), one batch in the caller's tenant
// run: the workspace's persons with a location and no country, after `after` in id order, locked
// until the run ends, get the country the place list reads now, with the location's provenance, as
// at creation. A country a member set or cleared stays (its provenance is a member's), and so does
// a person whose location the list cannot read. Counts and the last id only, never a value.
import { tenantClient } from "@whytide/db";
import { currentTenant } from "@whytide/platform";
import { BACKFILL_BATCH } from "./constants.ts";
import { countryOf } from "./countries.ts";
import { MEMBER, type ProvenanceMap } from "./provenance.ts";

export type BackfillBatch = {
  /** The persons read: with a location and no country. */
  readonly read: number;
  readonly filled: number;
  /** A member's country, left as it is. */
  readonly kept: number;
  /** A location the list cannot read. */
  readonly unread: number;
  /** The last id read, the next batch's `after`; null when none was read. */
  readonly last: string | null;
};
type Row = { id: string; locationText: string; fieldProvenance: ProvenanceMap };

export async function backfillCountries(after: string | null): Promise<BackfillBatch> {
  const { workspaceId } = currentTenant();
  const rows = await tenantClient.$queryRaw<Row[]>`
    SELECT id, location_text AS "locationText", field_provenance AS "fieldProvenance"
    FROM persons
    WHERE workspace_id = ${workspaceId} AND location_country IS NULL
      AND location_text IS NOT NULL AND location_text <> '' AND id > ${after ?? ""}
    ORDER BY id
    LIMIT ${BACKFILL_BATCH}
    FOR UPDATE`;
  let [filled, kept, unread] = [0, 0, 0];
  for (const { id, locationText, fieldProvenance } of rows) {
    const located = fieldProvenance.locationText;
    if (fieldProvenance.locationCountry?.source === MEMBER) {
      kept += 1;
      continue;
    }
    const country = countryOf(locationText);
    if (country === null || located === undefined) {
      unread += 1;
      continue;
    }
    await tenantClient.person.update({
      where: { id },
      data: {
        locationCountry: country,
        fieldProvenance: { ...fieldProvenance, locationCountry: located },
      },
    });
    filled += 1;
  }
  return { read: rows.length, filled, kept, unread, last: rows.at(-1)?.id ?? null };
}
