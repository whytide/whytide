// The top of "Up next" (README.md "Screen"): the title, what the screen is for, the counters "to
// approve" and "decided today" once the queue is read, the member's totals over their senders
// (gamma-p6-050), and the line that nothing here sends. The page renders it while the queue loads,
// and queue.tsx with the counters of its last read, so that a decision updates them without reading
// the page again.
import { Badge, PageHeader } from "@whytide/ui";
import { CircleCheck, Info, ListChecks } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import type { ItemsResponse } from "../../schemas/items.ts";

export function Header({ counts }: { counts?: ItemsResponse["counts"] }) {
  const t = useTranslations("approvals.up_next");
  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        meta={
          counts && (
            <>
              <Badge tone="accent">
                <ListChecks aria-hidden="true" />
                {t("count.to_approve", { count: counts.toApprove })}
              </Badge>
              <Badge tone="success">
                <CircleCheck aria-hidden="true" />
                {t("count.decided_today", { count: counts.decidedToday })}
              </Badge>
            </>
          )
        }
      />
      <p className="mb-6 flex max-w-3xl items-start gap-2 text-pretty text-ink-muted">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("nothing_sent")}
      </p>
    </>
  );
}
