// The link and the placing of values (gamma-rf-010; README.md "Shared companies"), in the caller's
// tenant run. Locks, always in this order so two runs never wait on each other in a circle: the
// workspace's row (FOR UPDATE); the link's key locks, the page's before the domain's, waited for;
// the shared company's row (FOR UPDATE), before any write to it or to a group's row on it; an
// offered key's lock, only tried, so an offer never waits.
import type { Provenance } from "../provenance.ts";
import { COMPANY_FACTS, COMPANY_KEYS, type CompanyKey, PROVIDER_REFS } from "./constants.ts";
import {
  EMPTY_LAYER,
  isKey,
  type Layer,
  type LayerField,
  mergeInto,
  type Placed,
  readLayers,
  readsOnePerson,
} from "./layers.ts";
import { type SharingGroup, sharedStamp } from "./sharing.ts";
import {
  lockKey,
  lockRow,
  lockShared,
  makeShared,
  readGroupRow,
  readShared,
  rowElsewhere,
  type SharedRow,
  setLink,
  sharedElsewhere,
  sharedWith,
  tryKey,
  type WorkspaceRow,
  writeGroupRow,
  writeRowKeys,
  writeShared,
} from "./store.ts";

/** A row after linkRow: its company, null for a row with no key; whether this run linked it. */
export type Linked = {
  readonly row: WorkspaceRow;
  readonly companyId: string | null;
  readonly linkedNow: boolean;
};

/**
 * The row's link, made when it has none: the shared company with the row's LinkedIn page, else the
 * one with its domain, else one made with that one key and no stamp for it. Then each fact and each
 * key the row holds, and its vendors' ids, go where a write with their stamps would put them, with
 * those stamps: the link's key lands on the group's row, as the shared company holds it already, so
 * the organization's other workspaces copy it down from there (copyDown). The row's own columns stay
 * as they are. A link never changes. Null when the run's workspace has no row with the id.
 */
export async function linkRow(rowId: string, group: SharingGroup): Promise<Linked | null> {
  const row = await lockRow(rowId);
  if (row === null) return null;
  if (row.companyId !== null) return { row, companyId: row.companyId, linkedNow: false };
  const companyId = await sharedFor(row);
  if (companyId === null) return { row, companyId: null, linkedNow: false };
  await setLink(row.id, companyId);
  const keys = COMPANY_KEYS.filter((key) => row[key] !== null);
  const fields: LayerField[] = [...COMPANY_FACTS, ...keys, PROVIDER_REFS];
  const values: Placed[] = fields.flatMap((field) => {
    const value = row[field];
    return value === null ? [] : [{ field, value, stamp: row.fieldProvenance[field] }];
  });
  await place({ group, companyId, values, onePerson: readsOnePerson(row) });
  return { row: { ...row, companyId }, companyId, linkedNow: true };
}

/** The id of the shared company to link the row to, under the keys' locks; null without a key. */
async function sharedFor(row: WorkspaceRow): Promise<string | null> {
  const keys = COMPANY_KEYS.flatMap((key) => {
    const value = row[key];
    return value === null ? [] : [{ key, value }];
  });
  for (const { key, value } of keys) {
    await lockKey(key, value);
    const companyId = await sharedWith(key, value);
    if (companyId !== null) return companyId;
  }
  const [first] = keys;
  return first === undefined ? null : makeShared(first.key, first.value);
}

/**
 * Places the values on the company's layers. A value goes to the shared company when its stamp's
 * class is shared (sharing.ts), unless the company is a one-person one (the write's headcount, or
 * what the company reads already): a key only when the shared company has none, no other shared
 * company holds it and its lock is free; everything else goes to the group's row. Each layer merges
 * as mergeFields does. The shared company's row is locked first, then the group's row is written.
 */
export async function place(input: {
  group: SharingGroup;
  companyId: string;
  values: readonly Placed[];
  onePerson: boolean;
}): Promise<void> {
  const { group, companyId, values } = input;
  if (values.length === 0) return;
  const shared = await lockShared(companyId);
  if (shared === null) return;
  const groupRow = await readGroupRow(group, companyId);
  const onePerson = input.onePerson || readsOnePerson(readLayers(shared, groupRow).values);
  const toShared: Placed[] = [];
  const toGroup: Placed[] = [];
  for (const value of values) {
    const shareable = !onePerson && sharedStamp(value.stamp);
    const offered = shareable && (!isKey(value.field) || (await keyFree(value, shared)));
    (offered ? toShared : toGroup).push(value);
  }
  if (toShared.length > 0) {
    const { values: changed, provenance } = mergeInto(shared, toShared);
    await writeShared(companyId, changed, provenance);
  }
  if (toGroup.length > 0) {
    const { values: changed, provenance } = mergeInto(groupRow ?? EMPTY_LAYER, toGroup);
    await writeGroupRow(group, companyId, changed, provenance);
  }
}

/** Whether a key may go to the shared company: it has none, its lock is free and no other has it. */
async function keyFree(placed: Placed, shared: SharedRow): Promise<boolean> {
  const key = placed.field as CompanyKey;
  const value = String(placed.value);
  if (shared[key] !== null || !(await tryKey(key, value))) return false;
  return !(await sharedElsewhere(key, value, shared.id));
}

/**
 * The keys the linked row lacks, copied down with their layer's stamp, unless another company of the
 * workspace holds the value: from the group's row, else from the shared company when the key carries
 * a stamp there, a shared class's (the CHECK holds every stamp there to one). The key that made the
 * shared company has none, whatever class brought it, so it never leaves the organization that made
 * it: that organization's workspaces copy it from the group's row, where the link put it.
 */
export async function copyDown(linked: Linked, group: SharingGroup): Promise<void> {
  const { row, companyId } = linked;
  if (companyId === null || COMPANY_KEYS.every((key) => row[key] !== null)) return;
  const [shared, groupRow] = [await readShared(companyId), await readGroupRow(group, companyId)];
  const values: Record<string, string> = {};
  const provenance: Record<string, Provenance> = { ...row.fieldProvenance };
  for (const key of COMPANY_KEYS) {
    const from = keyLayer(key, groupRow, shared);
    const value = from?.[key];
    if (row[key] !== null || from === null || value == null) continue;
    if (await rowElsewhere(key, value, row.id)) continue;
    values[key] = value;
    const stamp = from.fieldProvenance[key];
    if (stamp !== undefined) provenance[key] = stamp;
  }
  if (Object.keys(values).length > 0) await writeRowKeys(row.id, values, provenance);
}

/** The layer a key is copied down from: the group's row; else the shared company, if stamped there. */
function keyLayer(key: CompanyKey, groupRow: Layer | null, shared: Layer | null): Layer | null {
  if (groupRow?.[key] != null) return groupRow;
  return shared?.[key] != null && shared.fieldProvenance[key] !== undefined ? shared : null;
}
