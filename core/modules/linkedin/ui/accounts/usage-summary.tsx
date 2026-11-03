"use client";
// The account's limits today (README.md "Screen"), a card loaded in the browser with its loading
// state and its error state with a retry: the reads reserved and made over the day's read limit (the
// smaller of its allowance and the cap), in words and on a meter, which turns warm at the limit; the
// reads left; the connection requests and messages today against their limits, the connection
// requests of the last seven days against the weekly cap and every action against the 200, each on a
// meter of its own; and the working-hours window, open or closed, with the next window's start in
// the account's own time zone while it is closed. Below them, for a member who may manage the
// account, its daily read limit (read-limit.tsx); a saved one is the cap here at once.
import { ErrorState, LoadingState, Meter } from "@whytide/ui";
import { Clock, Gauge, Moon } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import type { UsageResponse } from "../../schemas/quota.ts";
import { ReadLimit } from "./read-limit.tsx";

type Props = {
  workspaceId: string;
  accountId: string;
  timeZone: string;
  /** The account's canManage: the daily read limit's field shows. */
  canManage: boolean;
  /** The cap changed here: the screen asks for the account again. */
  onCapChange: () => Promise<unknown>;
};

const NEXT = { weekday: "long", hour: "2-digit", minute: "2-digit" } as const;
const WINDOW = "flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";

/** One budget: its line in words over its meter, warm once it is used up. */
function Budget({ text, used, limit }: { text: string; used: number; limit: number }) {
  return (
    <li className="grid gap-1.5">
      <p className="text-sm text-ink tabular-nums">{text}</p>
      <Meter value={used} max={limit} tone={used < limit ? "accent" : "warm"} />
    </li>
  );
}

export function UsageSummary({ workspaceId, accountId, timeZone, canManage, onCapChange }: Props) {
  const t = useTranslations("linkedin.usage");
  const format = useFormatter();
  const title = useId();
  const [usage, setUsage] = useState<UsageResponse>();
  const [failure, setFailure] = useState<string>();

  const load = useCallback(async () => {
    setFailure(undefined);
    setUsage(undefined);
    try {
      const params = { path: { workspaceId, id: accountId } };
      const path = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/usage";
      setUsage(await data(browserApi().GET(path, { params })));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    }
  }, [workspaceId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const used = usage === undefined ? 0 : usage.reserved + usage.committed;
  // The reads stop at the smaller of the day's allowance and the cap as it stands now.
  const cap = usage === undefined ? 0 : Math.min(usage.readAllowance, usage.cap);
  return (
    <section
      aria-labelledby={title}
      className="grid min-w-0 content-start gap-5 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <h2 id={title} className="flex items-center gap-2 font-semibold text-ink">
        <Gauge aria-hidden="true" className="size-4 text-ink-muted" />
        {t("title")}
      </h2>
      {failure !== undefined ? (
        <ErrorState module="linkedin" code={failure} onRetry={load} />
      ) : usage === undefined ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid gap-2.5">
            <p className="text-xl font-semibold tracking-tight text-ink tabular-nums">
              {t("reads_today", { used, cap })}
            </p>
            <Meter size="md" value={used} max={cap} tone={used < cap ? "accent" : "warm"} />
            <p className="text-sm text-ink-muted tabular-nums">
              {t("reads_left", { left: Math.max(cap - used, 0) })}
            </p>
          </div>
          <ul className="grid gap-3.5">
            <Budget
              text={t("invites_today", usage.invites)}
              used={usage.invites.used}
              limit={usage.invites.limit}
            />
            <Budget
              text={t("messages_today", usage.messages)}
              used={usage.messages.used}
              limit={usage.messages.limit}
            />
            <Budget
              text={t("week_invites", usage.weekInvites)}
              used={usage.weekInvites.used}
              limit={usage.weekInvites.cap}
            />
            <Budget
              text={t("actions_today", usage.actions)}
              used={usage.actions.used}
              limit={usage.actions.max}
            />
          </ul>
          {usage.windowOpen ? (
            <p className={`${WINDOW} bg-success-soft text-success-ink`}>
              <Clock aria-hidden="true" className={ICON} />
              {t("window_open")}
            </p>
          ) : (
            <div className={`${WINDOW} bg-muted text-ink`}>
              <Moon aria-hidden="true" className={`${ICON} text-ink-muted`} />
              <div className="grid gap-0.5">
                <p className="my-3">{t("window_closed")}</p>
                <p className="text-ink-muted">
                  {t("next_window", {
                    at: format.dateTime(new Date(usage.nextWindowAt), { ...NEXT, timeZone }),
                  })}
                </p>
              </div>
            </div>
          )}
          {canManage ? (
            <div className="border-t border-line pt-5">
              <ReadLimit
                workspaceId={workspaceId}
                accountId={accountId}
                cap={usage.cap}
                capMax={usage.capMax}
                onSaved={(cap) => {
                  setUsage({ ...usage, cap });
                  void onCapChange();
                }}
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
