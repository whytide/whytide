// The provider_refs convention (docs/architecture.md §9 rule 5, docs/rules/coding.md §5): a vendor's
// id for one of our rows sits in the row's jsonb column `provider_refs`, keyed by adapter name, never
// in a domain column; the schema lint of core/packages/db rejects a column named with a vendor.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { ADAPTER_NAME } from "./config.ts";
import { patternErrors } from "./errors.ts";

/** Adapter name to the vendor's id: `{ unipile: "acc_123" }`. */
export const providerRefs = z.record(z.string().regex(ADAPTER_NAME), z.string().min(1));
export type ProviderRefs = z.infer<typeof providerRefs>;

/** A copy of the row with `providerRefs[adapter]` set to `id`; the Prisma field of the column. */
export function setProviderRef<R extends { readonly providerRefs?: unknown }>(
  row: R,
  adapter: string,
  id: string,
): Omit<R, "providerRefs"> & { readonly providerRefs: ProviderRefs } {
  const current = providerRefs.safeParse(row.providerRefs ?? {});
  if (!current.success) {
    throw new AppError(patternErrors.provider_ref_invalid, {
      details: { adapter, reason: "provider_refs holds something other than ids by adapter name" },
    });
  }
  const next = providerRefs.safeParse({ ...current.data, [adapter]: id });
  if (!next.success) {
    throw new AppError(patternErrors.provider_ref_invalid, {
      details: { adapter, reason: "a ref is a non-empty id under an adapter folder name" },
    });
  }
  return { ...row, providerRefs: next.data } as Omit<R, "providerRefs"> & {
    readonly providerRefs: ProviderRefs;
  };
}
