// The inbox's list in the browser (page.tsx gives it the first read): a table of the threads, newest
// first, each row the lead's name with their title and company, the time of the last message, who
// wrote last and a "to label" badge with the replies that wait for a label; a row opens the thread.
// "Load more" reads the next page (GET …/inbox/threads after the last page's cursor) and adds its
// rows under the others. The states: empty, no replies yet; a failed read in words, its module's
// (src/api/errors.ts errorOwner), with Try again, which reads that page again.
"use client";

import { Badge, Button, type Column, DataTable, EmptyState, ErrorState } from "@whytide/ui";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import type { ThreadPage, ThreadSummaryResponse } from "../../schemas/threads.ts";
import { PAGE_SIZE, TIME_FORMAT } from "./constants.ts";
import { usePersonWords } from "./person.ts";

/** The first read's answer, or the digest of its refusal (`api:<code>`, src/api/errors.ts). */
type Props = { workspace: string } & ({ first: ThreadPage } | { failed: string });
type Row = ThreadSummaryResponse;
/** The rows read so far, and the next page's cursor: null after the last page. */
type Shown = { readonly threads: Row[]; readonly next: string | null };
/** A read that failed: its digest, and the cursor it read after (none for the first page). */
type Failure = { readonly digest: string; readonly cursor?: string };

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

export function Threads(props: Props) {
  const { workspace } = props;
  const t = useTranslations("inbox.list");
  const format = useFormatter();
  const messages = useMessages();
  const person = usePersonWords();
  const id = useId();
  const [shown, setShown] = useState<Shown | undefined>(
    "first" in props ? { threads: props.first.threads, next: props.first.nextCursor } : undefined,
  );
  const [failure, setFailure] = useState<Failure | undefined>(
    "failed" in props ? { digest: props.failed } : undefined,
  );
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  /** A page read: the first replaces the rows, a next one adds its own; the last read wins. */
  async function read(cursor?: string) {
    const ask = ++asked.current;
    setBusy(true);
    try {
      const page = await data(
        browserApi().GET("/v1/workspaces/{workspaceId}/inbox/threads", {
          params: { path: { workspaceId: workspace }, query: { limit: PAGE_SIZE, cursor } },
        }),
      );
      if (ask !== asked.current) return;
      setShown((before) => {
        if (cursor === undefined || before === undefined) {
          return { threads: page.threads, next: page.nextCursor };
        }
        const seen = new Set(before.threads.map((thread) => thread.id));
        const added = page.threads.filter((thread) => !seen.has(thread.id));
        return { threads: [...before.threads, ...added], next: page.nextCursor };
      });
      setFailure(undefined);
    } catch (error) {
      if (ask === asked.current) setFailure({ digest: digestOf(error), cursor });
    } finally {
      if (ask === asked.current) setBusy(false);
    }
  }

  const owner = failure && errorOwner({ digest: failure.digest }, messages);
  if (shown === undefined) {
    return (
      <section aria-labelledby={`${id}-error`} className="grid max-w-3xl gap-3">
        <h2 id={`${id}-error`} className="font-semibold text-ink">
          {t("error")}
        </h2>
        <ErrorState
          module={owner?.module ?? "web"}
          code={owner?.code ?? "internal_error"}
          onRetry={() => void read()}
        />
      </section>
    );
  }

  const columns: Column<Row>[] = [
    {
      id: "lead",
      header: t("columns.lead"),
      cell: (thread) => {
        const role = person.role(thread.person);
        return (
          <span className="grid min-w-44">
            <span>{person.name(thread.person)}</span>{" "}
            {role && <span className="text-xs font-normal text-ink-muted">{role}</span>}
          </span>
        );
      },
    },
    {
      id: "last_message",
      header: t("columns.last_message"),
      cell: ({ lastMessageAt }) => (
        <time dateTime={lastMessageAt} className="whitespace-nowrap">
          {format.dateTime(new Date(lastMessageAt), TIME_FORMAT)}
        </time>
      ),
    },
    {
      id: "last_from",
      header: t("columns.last_from"),
      cell: ({ lastDirection }) =>
        lastDirection === null ? null : lastDirection === "in" ? t("from.lead") : t("from.account"),
    },
    {
      id: "to_label",
      header: t("columns.to_label"),
      cell: ({ toLabel }) =>
        toLabel > 0 && <Badge tone="accent">{t("to_label", { count: toLabel })}</Badge>,
    },
  ];
  const { next } = shown;

  return (
    <div className="grid gap-4">
      <DataTable
        caption={t("caption")}
        columns={columns}
        rows={shown.threads}
        rowHref={(thread) => `/w/${workspace}/inbox/${thread.id}`}
        pager={{}}
        empty={<EmptyState message={t("empty")} />}
      />
      {owner && (
        <ErrorState
          module={owner.module}
          code={owner.code}
          onRetry={() => void read(failure?.cursor)}
        />
      )}
      {next !== null && (
        <div>
          <Button loading={busy} onClick={() => void read(next)}>
            {t("load_more")}
          </Button>
        </div>
      )}
    </div>
  );
}
