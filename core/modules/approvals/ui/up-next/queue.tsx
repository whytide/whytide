// "Up next" in the browser (page.tsx gives it the first read): the header with the counters of the
// last read; the rows (item.tsx) grouped as "Overdue", the stale ones, then by the local day and hour
// they are due in their sender's zone, in the api's order; the empty state; a read that failed, its
// code in words with Try again. The queue is read again (GET …/approvals/items, the last read
// winning) after each decision, and every POLL_MS while a row's draft is being written, until it has
// been drafting POLL_MAX_MS since its step opened: then a note says so, with Check again, which reads
// it once more. A failed read shows its code in words, its module's (src/api/errors.ts errorOwner),
// with Try again. A toast says what a decision did.
"use client";

import { Button, EmptyState, ErrorState, Toast } from "@whytide/ui";
import { Hourglass, RefreshCw } from "@whytide/ui/icons";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ItemResponse, ItemsResponse } from "../../schemas/items.ts";
import { GROUP_FORMAT, MS_PER_MINUTE, POLL_MAX_MS, POLL_MS, TOAST_MS } from "./constants.ts";
import { Header } from "./header.tsx";
import { Item, isDrafting, zoneOf } from "./item.tsx";

/** The first read's answer, or the digest of its refusal (`api:<code>`, src/api/errors.ts). */
type Props = { workspace: string } & ({ first: ItemsResponse } | { failed: string });
type Group = { readonly key: string; readonly heading: string; readonly items: ItemResponse[] };

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

export function Queue(props: Props) {
  const { workspace } = props;
  const t = useTranslations("approvals.up_next");
  const format = useFormatter();
  const messages = useMessages();
  const id = useId();
  const [queue, setQueue] = useState("first" in props ? props.first : undefined);
  const [failure, setFailure] = useState("failed" in props ? props.failed : undefined);
  const [busy, setBusy] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [toast, setToast] = useState<string>();
  const asked = useRef(0);

  /** The queue read again; a poll's read leaves the rows as they are while it runs. */
  const load = useCallback(
    async (quiet = false) => {
      const ask = ++asked.current;
      if (!quiet) setBusy(true);
      try {
        const params = { path: { workspaceId: workspace } };
        const read = browserApi().GET("/v1/workspaces/{workspaceId}/approvals/items", { params });
        const next = await data(read);
        if (ask !== asked.current) return;
        setQueue(next);
        setFailure(undefined);
      } catch (error) {
        if (ask === asked.current) setFailure(digestOf(error));
      } finally {
        if (ask === asked.current) setBusy(false);
      }
    },
    [workspace],
  );

  // While a row's draft is being written, the queue is read again, until it has been drafting too
  // long. The browser's clock decides, after the render, so the server's HTML and the browser's agree.
  useEffect(() => {
    const drafting = queue?.items.filter(isDrafting) ?? [];
    const fresh = drafting.some((item) => Date.now() - Date.parse(item.createdAt) < POLL_MAX_MS);
    setStalled(drafting.length > 0 && !fresh);
    if (!fresh || failure !== undefined) return;
    const timer = setTimeout(() => void load(true), POLL_MS);
    return () => clearTimeout(timer);
  }, [queue, failure, load]);

  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /** A decision done: its toast, and the queue read again, which no longer holds the row. */
  const decided = (message: string) => {
    setToast(message);
    void load();
  };

  const owner = failure === undefined ? undefined : errorOwner({ digest: failure }, messages);
  if (queue === undefined) {
    return (
      <>
        <Header />
        <section aria-labelledby={`${id}-error`} className="grid max-w-3xl gap-3">
          <h2 id={`${id}-error`} className="font-semibold text-ink">
            {t("error")}
          </h2>
          <ErrorState
            module={owner?.module ?? "web"}
            code={owner?.code ?? "internal_error"}
            onRetry={() => void load()}
          />
        </section>
      </>
    );
  }

  const heading = (item: ItemResponse) =>
    format.dateTime(new Date(item.scheduledFor), { ...GROUP_FORMAT, timeZone: zoneOf(item) });
  const groups = new Map<string, Group>();
  const overdue: Group = { key: "overdue", heading: t("group.overdue"), items: [] };
  for (const item of queue.items) {
    if (item.stale) {
      overdue.items.push(item);
      continue;
    }
    const at = heading(item);
    const group = groups.get(at) ?? { key: `at-${groups.size}`, heading: at, items: [] };
    group.items.push(item);
    groups.set(at, group);
  }
  const shown = [...(overdue.items.length > 0 ? [overdue] : []), ...groups.values()];

  return (
    <>
      <Header counts={queue.counts} />
      {owner && (
        <div className="mb-6 max-w-3xl">
          <ErrorState module={owner.module} code={owner.code} onRetry={() => void load()} />
        </div>
      )}
      {stalled && (
        <div
          role="status"
          className="mb-6 grid max-w-3xl justify-items-start gap-2.5 rounded-lg border border-warm-dot/30 bg-warm-soft px-4 py-3 text-warm-ink"
        >
          <p className="flex items-start gap-2">
            <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("stuck", { minutes: POLL_MAX_MS / MS_PER_MINUTE })}
          </p>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden="true" />
            {t("check_again")}
          </Button>
        </div>
      )}
      {queue.items.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <div
          aria-busy={busy || undefined}
          className="grid gap-8 transition-opacity duration-150 aria-busy:opacity-60"
        >
          {shown.map((group) => (
            <section
              key={group.key}
              aria-labelledby={`${id}-${group.key}`}
              className="grid min-w-0 gap-3"
            >
              <h2 id={`${id}-${group.key}`} className="text-sm font-semibold text-ink-muted">
                {group.heading}
              </h2>
              <ul className="grid min-w-0 gap-3">
                {group.items.map((item) => (
                  <Item key={item.id} workspace={workspace} item={item} onDecided={decided} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <Toast message={toast} />
    </>
  );
}
