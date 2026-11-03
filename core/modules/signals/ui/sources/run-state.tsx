"use client";
// The line of a source's open run, in its card (README.md "Screen"): why Run now is disabled, in
// words. A running run reads now; a waiting one waits on its sender account: not connected, with the
// link to the LinkedIn screen as the card's warning has; today's reads used, N of N; or outside the
// working hours; each with when it reads again, linkedin's usage `nextWindowAt` in the account's time
// zone, as the runs panel shows it. The screen reads each account's usage once.
import { Link } from "@whytide/ui";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { CONNECTED, linkedinScreen, runStateId } from "./constants.ts";
import type { Account, Source, Usage } from "./source-list.tsx";
import { FORMAT } from "./when.tsx";

type Props = {
  workspaceId: string;
  source: Source;
  sender: Account | undefined;
  /** The sender account's usage, read for a waiting run; undefined when that read failed. */
  usage: Usage | undefined;
};

export function RunState({ workspaceId, source, sender, usage }: Props) {
  const t = useTranslations("signals");
  const format = useFormatter();
  const run = source.openRun;
  if (!run) return null;
  const line = (words: ReactNode) => (
    <p id={runStateId(source.id)} className="min-w-0 flex-1 basis-48 text-pretty">
      {words}
    </p>
  );
  if (run.status === "running") return line(t("sources.run_reading"));
  if (sender?.status !== CONNECTED) {
    return line(
      <>
        {t("sources.run_waiting_account")}{" "}
        <Link href={linkedinScreen(workspaceId)}>{t("sources.blocked")}</Link>
      </>,
    );
  }
  if (usage === undefined) return line(t("runs.status.waiting"));
  const { cap, nextWindowAt } = usage;
  const at = format.dateTime(new Date(nextWindowAt), { ...FORMAT, timeZone: sender.timeZone });
  const time = (chunks: ReactNode) => <time dateTime={nextWindowAt}>{chunks}</time>;
  const used = usage.reserved + usage.committed;
  if (used >= cap) return line(t.rich("sources.run_waiting_cap", { used, cap, at, time }));
  if (!usage.windowOpen) return line(t.rich("sources.run_waiting_hours", { at, time }));
  // Neither, as when its wait is about to end: when it reads again, as the runs panel says it.
  return line(t.rich("runs.waiting_until", { at, time }));
}
