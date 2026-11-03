"use client";
// The signed-in user's account on the LinkedIn screen (README.md "Screen"), loaded in the browser:
// the loading state, with the cards shimmering where they will come; the error state with a retry;
// the empty state, the sentence that no account is connected heading the disclosure and Connect;
// then the account's card and, while it is not connected, the disclosure and Connect under it, with
// its reads today beside them on a wide screen, under them on a phone. The account is asked for
// again every two seconds while the screen waits: for the provider's webhook while it is pending, two
// minutes at most, or after Refresh status for the worker's answer, until its status changes, thirty
// seconds at most. Under the account's card, once it is not pending, its health (health-card.tsx).
import { ErrorState, LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import type { AccountResponse } from "../../schemas/accounts.ts";
import { AccountCard } from "./account-card.tsx";
import { ConnectPanel } from "./connect-panel.tsx";
import { LOADING_LINES } from "./constants.ts";
import { HealthCard } from "./health-card.tsx";
import { UsageSummary } from "./usage-summary.tsx";

/** The account's column and, from xl, its reads today beside it, over every row. */
const LAYOUT =
  "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_auto_1fr]";
const SIDE = "min-w-0 xl:col-start-2 xl:row-span-3 xl:row-start-1";
const CARD = "rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6";

/** What the screen waits for: a status other than `from`, `left` polls more at most. */
type Wait = { readonly from: AccountResponse["status"]; readonly left: number };

const POLL_MS = 2_000;
const PENDING_POLLS = 60;
const REFRESH_POLLS = 15;

export function Accounts({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("linkedin.accounts");
  const id = useId();
  /** Undefined while it loads; null when the user has no account in the workspace. */
  const [mine, setMine] = useState<AccountResponse | null>();
  const [failure, setFailure] = useState<string>();
  const [wait, setWait] = useState<Wait>();

  const load = useCallback(async () => {
    try {
      const { accounts } = await data(
        browserApi().GET("/v1/workspaces/{workspaceId}/linkedin/accounts", {
          params: { path: { workspaceId } },
        }),
      );
      const found = accounts.find((account) => account.mine) ?? null;
      setMine(found);
      return found;
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
      setWait(undefined);
      return undefined;
    }
  }, [workspaceId]);

  /** The first load, and the retry: the loading state, then the account; a pending one is watched. */
  const open = useCallback(async () => {
    setFailure(undefined);
    setMine(undefined);
    const found = await load();
    if (found?.status === "pending") setWait({ from: "pending", left: PENDING_POLLS });
  }, [load]);

  useEffect(() => {
    void open();
  }, [open]);

  useEffect(() => {
    if (wait === undefined) return;
    if (wait.left === 0 || mine?.status !== wait.from) {
      setWait(undefined);
      return;
    }
    const timer = setTimeout(async () => {
      await load();
      setWait((current) => current && { ...current, left: current.left - 1 });
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [wait, mine, load]);

  if (failure !== undefined) {
    return (
      <section aria-labelledby={`${id}-error`} className="grid max-w-3xl gap-3">
        <h2 id={`${id}-error`} className="font-semibold text-ink">
          {t("error")}
        </h2>
        <ErrorState module="linkedin" code={failure} onRetry={open} />
      </section>
    );
  }
  if (mine === undefined) {
    const [account, usage] = LOADING_LINES;
    return (
      <section aria-label={t("loading")} aria-busy="true" className="grid gap-4">
        <LoadingState />
        <div aria-hidden="true" className={LAYOUT}>
          <div className={CARD}>
            <Skeleton lines={account} />
          </div>
          <div className={`${CARD} ${SIDE}`}>
            <Skeleton lines={usage} />
          </div>
        </div>
      </section>
    );
  }
  if (mine === null) {
    return (
      <div className="max-w-3xl">
        <ConnectPanel workspaceId={workspaceId} intro={t("empty")} />
      </div>
    );
  }
  return (
    <div className={LAYOUT}>
      <AccountCard
        workspaceId={workspaceId}
        account={mine}
        refreshing={wait !== undefined && wait.from !== "pending"}
        onRefresh={() => setWait({ from: mine.status, left: REFRESH_POLLS })}
        onChange={load}
      />
      {mine.status === "pending" ? null : (
        <HealthCard key={mine.status} workspaceId={workspaceId} account={mine} onChange={load} />
      )}
      {mine.status === "connected" ? null : <ConnectPanel workspaceId={workspaceId} />}
      <div className={SIDE}>
        <UsageSummary
          workspaceId={workspaceId}
          accountId={mine.id}
          timeZone={mine.timeZone}
          canManage={mine.canManage}
          onCapChange={load}
        />
      </div>
    </div>
  );
}
