// The never-contact list's loading state (list.tsx while its first read runs): the wait in the
// module's words, announced, and a table's rows that shimmer where the entries will come.
import { Skeleton } from "@whytide/ui";
import { useTranslations } from "next-intl";
import { LOADING_ROWS } from "./constants.ts";

export function NeverContactLoading() {
  const t = useTranslations("contacts.never_contact");
  return (
    <div className="grid gap-3">
      <p role="status" className="wt-loading-state text-sm">
        <span className="wt-spinner" aria-hidden="true" />
        {t("loading")}
      </p>
      <Skeleton shape="table" lines={LOADING_ROWS} />
    </div>
  );
}
