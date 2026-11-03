// The lead list's loading state (page.tsx while its first read runs, list.tsx while a filter
// reads again): the wait in the module's words, announced, and a table's rows that shimmer where the
// leads will come.
import { Skeleton } from "@whytide/ui";
import { useTranslations } from "next-intl";
import { LOADING_ROWS } from "./constants.ts";

export function LeadsLoading() {
  const t = useTranslations("contacts.leads");
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
