// What may cross organizations (gamma-rf-010; README.md "Shared companies"), decided here and nowhere
// else: a value goes to the shared company when its stamp's class is one CONTACTS_SHARED_FACT_SOURCES
// names, which can only be among SHAREABLE_CLASSES (settings.ts); the migration's CHECK on
// companies.field_provenance holds the same list whatever the code does. The sharing group is
// tenancy's for the run, never a caller's.
import { sharingGroupOf } from "@whytide/tenancy";
import { sharingSettings } from "../../settings.ts";
import type { Provenance } from "../provenance.ts";
import type { ShareableClass } from "./constants.ts";

declare const groupBrand: unique symbol;
/** A sharing group's id as tenancy answered it for the run (runGroup); no caller makes one. */
export type SharingGroup = string & { readonly [groupBrand]: true };

let fixed: readonly ShareableClass[] | undefined;

/** The classes in place of the setting's, for tests; undefined goes back to the setting. */
export function useSharedClasses(classes: readonly ShareableClass[] | undefined): void {
  fixed = classes;
}

/** Whether a value with the stamp may go to the shared company: its class is a shared one. */
export function sharedStamp(stamp: Provenance | undefined): boolean {
  const classes: readonly string[] = fixed ?? sharingSettings.CONTACTS_SHARED_FACT_SOURCES;
  return stamp !== undefined && classes.includes(stamp.source);
}

/** The run's sharing group (tenancy's sharingGroupOf), or null for a workspace tenancy lacks. */
export async function runGroup(): Promise<SharingGroup | null> {
  return (await sharingGroupOf()) as SharingGroup | null;
}
