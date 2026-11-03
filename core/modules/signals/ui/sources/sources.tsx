"use client";
// The sources screen in the browser (README.md "Screen"): the workspace's sources and linkedin's
// sender accounts, read through the web's API client, with the loading state (the cards as
// skeletons) and the error state with a retry, then the usage of each account a run waits on, once
// per account; then the add form, the list and the runs panel of the source the address names. A
// change reads them again; Run now too, and opens its source's runs panel, which reads the new run.
// While a run reads, or until the run Run now asked for starts, the list alone is read again every
// SOURCES_POLL_MS, so that its card follows it.
import { ErrorState, LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AddSourceForm } from "./add-source-form.tsx";
import { CONNECTED, SKELETON, SOURCES_POLL_MS } from "./constants.ts";
import { RunsPanel } from "./runs-panel.tsx";
import { type Account, type Source, SourceList, type Usage } from "./source-list.tsx";

type Loaded = {
  readonly sources: Source[];
  readonly accounts: Account[];
  readonly usage: ReadonlyMap<string, Usage>;
};

export function SourcesScreen(props: { workspaceId: string; runsOf: string | undefined }) {
  const { workspaceId } = props;
  const t = useTranslations("signals.sources");
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<string>();
  /** The source whose runs show, and the runs asked for: the panel reads again after each. */
  const [runs, setRuns] = useState({ of: props.runsOf, asked: 0 });
  /** The source Run now asked a run of, and its last run then, which the run's start changes. */
  const [starting, setStarting] = useState<Pick<Source, "id" | "lastRunAt">>();

  /** The whole screen: the sources and the sender accounts, then the usage a run waits on. */
  const read = useCallback(async (): Promise<Loaded> => {
    const api = browserApi();
    const path = { workspaceId };
    const [{ sources }, { accounts }] = await Promise.all([
      data(api.GET("/v1/workspaces/{workspaceId}/signals/sources", { params: { path } })),
      data(api.GET("/v1/workspaces/{workspaceId}/linkedin/accounts", { params: { path } })),
    ]);
    return { sources, accounts, usage: await usageOf(workspaceId, sources, accounts) };
  }, [workspaceId]);

  const load = useCallback(async () => {
    try {
      setLoaded(await read());
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    }
  }, [read]);

  /** The first read, and the retry: the loading state, then the screen. */
  const open = useCallback(async () => {
    setFailure(undefined);
    setLoaded(undefined);
    await load();
  }, [load]);

  useEffect(() => {
    void open();
  }, [open]);

  // While a run reads, or until the run Run now asked for starts, the list again after a while,
  // quietly; a run that waits now on an account whose usage the screen lacks reads the whole screen
  // again. A read that fails leaves the screen as it is, and the next one reads again. A read still
  // under way when the screen changes or closes is dropped: it never overwrites a newer one.
  useEffect(() => {
    if (loaded === undefined) return;
    const asked = loaded.sources.find(({ id }) => id === starting?.id);
    const unstarted = asked?.openRun === null && asked.lastRunAt === starting?.lastRunAt;
    if (!unstarted && !loaded.sources.some(({ openRun }) => openRun?.status === "running")) return;
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const path = { workspaceId };
        const { sources } = await data(
          browserApi().GET("/v1/workspaces/{workspaceId}/signals/sources", { params: { path } }),
        );
        const unread = sources.some(
          ({ openRun, senderAccountId }) =>
            openRun?.status === "waiting" && !loaded.usage.has(senderAccountId),
        );
        const whole = unread ? await read() : undefined;
        if (live) setLoaded((shown) => whole ?? (shown && { ...shown, sources }));
      } catch {
        if (live) timer = window.setTimeout(() => void poll(), SOURCES_POLL_MS);
      }
    };
    timer = window.setTimeout(() => void poll(), SOURCES_POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [loaded, starting, read, workspaceId]);

  /** A run asked for: its source's runs panel, in the address too, and the list read again. */
  const ran = (source: Source) => {
    window.history.replaceState(null, "", `?runs=${encodeURIComponent(source.id)}`);
    setRuns(({ asked }) => ({ of: source.id, asked: asked + 1 }));
    setStarting({ id: source.id, lastRunAt: source.lastRunAt });
    void load();
  };

  if (failure !== undefined) {
    return (
      <section aria-labelledby="signals-sources-error" className="grid gap-3">
        <h2 id="signals-sources-error" className="font-semibold text-ink">
          {t("error")}
        </h2>
        <ErrorState module="signals" code={failure} onRetry={open} />
      </section>
    );
  }
  if (loaded === undefined) {
    const card = "grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs";
    return (
      <section aria-label={t("loading")} aria-busy="true" className="grid gap-6">
        <LoadingState />
        <div aria-hidden="true" className={card}>
          <Skeleton lines={SKELETON.formLines} />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: SKELETON.cards }, (_, index) => (
            <div key={index} aria-hidden="true" className={card}>
              <Skeleton lines={SKELETON.cardLines} />
            </div>
          ))}
        </div>
      </section>
    );
  }
  const { sources, accounts, usage } = loaded;
  const shown = sources.find((source) => source.id === runs.of);
  return (
    <div className="grid gap-6">
      <AddSourceForm workspaceId={workspaceId} accounts={accounts} onAdded={load} />
      <SourceList
        workspaceId={workspaceId}
        sources={sources}
        accounts={accounts}
        usage={usage}
        onChange={load}
        onRan={ran}
        runsOf={shown?.id}
      />
      {shown ? (
        <RunsPanel
          key={`${shown.id}:${runs.asked}`}
          workspaceId={workspaceId}
          source={shown}
          sender={accounts.find((account) => account.id === shown.senderAccountId)}
        />
      ) : null}
    </div>
  );
}

/**
 * linkedin's usage of each connected sender account a run of the screen waits on, read once per
 * account however many of its sources wait. A read that fails leaves its account out, so that the
 * line under Run now says only that the run waits, and the screen stays.
 */
async function usageOf(workspaceId: string, sources: Source[], accounts: Account[]) {
  const waiting = new Set(
    sources.filter(({ openRun }) => openRun?.status === "waiting").map((s) => s.senderAccountId),
  );
  const ids = accounts.filter((a) => a.status === CONNECTED && waiting.has(a.id)).map((a) => a.id);
  const api = browserApi();
  const read = async (id: string): Promise<[string, Usage] | undefined> => {
    try {
      const params = { path: { workspaceId, id } };
      const path = "/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/usage";
      return [id, await data(api.GET(path, { params }))];
    } catch {
      return undefined;
    }
  };
  const entries = await Promise.all(ids.map(read));
  return new Map(entries.filter((entry) => entry !== undefined));
}
