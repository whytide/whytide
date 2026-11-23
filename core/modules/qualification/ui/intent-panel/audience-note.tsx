"use client";
// The audience the lead was judged against (README "Screen"; gamma-p5-050), above the intent in the
// evidence slot of contacts' lead page: its name as icp keeps it, or the words for the default or
// an unnamed audience when it has none.
import { useTranslations } from "next-intl";
import type { SnapshotResponse } from "../../schemas/snapshot.ts";

type Audience = NonNullable<SnapshotResponse["audience"]>;

export function AudienceNote({ audience }: { audience: Audience }) {
  const t = useTranslations("qualification.snapshot");
  const name = audience.name.trim();
  const kind = name !== "" ? "named" : audience.isDefault ? "default" : "unnamed";
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-3 shadow-xs">
      <p className="text-sm text-ink">{t("audience", { kind, name })}</p>
    </div>
  );
}
