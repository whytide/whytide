// The never-contact screen's exclusion lists (README.md "Screens"; list.tsx, under the add form): a
// card that imports a CSV file of company domains as one list of customers or competitors, POST
// …/contacts/exclusions/imports with the file as multipart/form-data, then says what it added and
// its duplicates and names each row without an entry by its number and its code in words, never a
// cell; and the lists, GET …/contacts/exclusions/lists a page at a time, newest first, a removed one
// marked so, with its states: loading, a failed read in words with a retry, and empty. Remove lifts
// a list's exclusions, so only an Owner or an Admin has it (the role list.tsx reads from GET
// /v1/me): after its confirmation it sends DELETE …/exclusions/lists/{listId}. An import or a removal
// reads the lists and the never-contact list again; list.tsx's toast says a removal. The limits are
// the api's: a file past them is refused in words, the host's payload_too_large as the file's own
// exclusions_too_large.
"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Select,
  Skeleton,
} from "@whytide/ui";
import { FileUp, Trash2 } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { RowCode } from "../../domain/exclusions/constants.ts";
import type { SuppressionRelationship } from "../../domain/suppression/constants.ts";
import type { ExclusionImportResponse, ExclusionListResponse } from "../../schemas/exclusions.ts";
import { LOADING_ROWS, PAGE_SIZE } from "./constants.ts";

const IMPORTS = "/v1/workspaces/{workspaceId}/contacts/exclusions/imports";
const LISTS = "/v1/workspaces/{workspaceId}/contacts/exclusions/lists";
const LIST = "/v1/workspaces/{workspaceId}/contacts/exclusions/lists/{listId}";

type List = ExclusionListResponse;
/** A page read: its lists, the next page's cursor, and the cursors that led to it. */
type Shown = { readonly lists: List[]; readonly next: string | null; readonly cursors: string[] };
/** A read that failed: its code, and the cursors to read again with. */
type Failure = { readonly code: string; readonly cursors: string[] };

/** The api's code; the host's payload_too_large, a body past twice the file's limit, the file's. */
function codeOf(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "internal_error";
  return code === "payload_too_large" ? "exclusions_too_large" : code;
}

export function Exclusions(props: {
  workspace: string;
  /** The signed-in user's id, once GET /v1/me answered. */
  viewer: string | undefined;
  /** An Owner or an Admin: the one who may remove a list. */
  lifts: boolean;
  /** Reads the never-contact list again, once a list is imported or removed, with the toast's words. */
  onChanged: (toast?: string) => void;
}) {
  const { workspace, viewer, lifts, onChanged } = props;
  const t = useTranslations("contacts");
  const format = useFormatter();
  const id = useId();
  const [relationship, setRelationship] = useState<SuppressionRelationship>("customer");
  const [file, setFile] = useState<File>();
  const [importing, setImporting] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [result, setResult] = useState<ExclusionImportResponse>();
  const [shown, setShown] = useState<Shown>();
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<List>();
  const [removeFailed, setRemoveFailed] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const latest = useRef(0);

  const read = useCallback(
    async (cursors: string[]) => {
      const run = ++latest.current;
      setBusy(true);
      try {
        const query = { limit: PAGE_SIZE, cursor: cursors.at(-1) };
        const page = await data(
          browserApi().GET(LISTS, { params: { path: { workspaceId: workspace }, query } }),
        );
        if (run !== latest.current) return;
        setFailure(undefined);
        setShown({ lists: page.lists, next: page.nextCursor, cursors });
      } catch (error) {
        if (run === latest.current) setFailure({ code: codeOf(error), cursors });
      } finally {
        if (run === latest.current) setBusy(false);
      }
    },
    [workspace],
  );
  useEffect(() => {
    void read([]);
  }, [read]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === undefined || running.current) return;
    running.current = true;
    setImporting(file.name);
    setProblem(undefined);
    setResult(undefined);
    try {
      const body = new FormData();
      body.append("file", file);
      // A multipart route has no body in the api's document, so the client's type takes none;
      // openapi-fetch sends a FormData as it is and leaves its boundary to the browser.
      const params = { path: { workspaceId: workspace }, query: { relationship } };
      setResult(await data(browserApi().POST(IMPORTS, { params, body: body as never })));
      setFile(undefined);
      if (picker.current) picker.current.value = "";
      void read([]);
      onChanged();
    } catch (error) {
      setProblem(codeOf(error));
    } finally {
      running.current = false;
      setImporting(undefined);
    }
  }

  async function remove(list: List) {
    setRemoving(undefined);
    setRemoveFailed(undefined);
    try {
      const params = { path: { workspaceId: workspace, listId: list.id } };
      await data(browserApi().DELETE(LIST, { params }));
      void read([]);
      onChanged(t("exclusions.toast.removed"));
    } catch (error) {
      setRemoveFailed(codeOf(error));
    }
  }

  const relationshipText: Record<SuppressionRelationship, string> = {
    customer: t("never_contact.relationship.customer"),
    competitor: t("never_contact.relationship.competitor"),
  };
  const rowText: Record<RowCode, (row: string) => string> = {
    domain_invalid: (row) => t("exclusions.row.domain_invalid", { row }),
    duplicate: (row) => t("exclusions.row.duplicate", { row }),
  };
  const columns: Column<List>[] = [
    {
      id: "name",
      header: t("exclusions.columns.name"),
      cell: ({ name, removedAt }) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="break-all">{name}</span>{" "}
          {removedAt !== null && <Badge>{t("exclusions.removed")}</Badge>}
        </span>
      ),
    },
    {
      id: "kind",
      header: t("exclusions.columns.kind"),
      cell: (list) => <Badge tone="accent">{relationshipText[list.relationship]}</Badge>,
    },
    {
      id: "entries",
      header: t("exclusions.columns.entries"),
      cell: ({ entryCount }) => <span className="tabular-nums">{format.number(entryCount)}</span>,
    },
    {
      id: "added_by",
      header: t("exclusions.columns.added_by"),
      cell: ({ createdBy }) => {
        if (viewer === undefined) return null;
        return createdBy === viewer
          ? t("never_contact.added_by.you")
          : t("never_contact.added_by.teammate");
      },
    },
    {
      id: "added",
      header: t("exclusions.columns.added"),
      cell: ({ createdAt }) => (
        <time dateTime={createdAt} className="whitespace-nowrap">
          {format.dateTime(new Date(createdAt), { dateStyle: "medium" })}
        </time>
      ),
    },
  ];
  if (lifts) {
    columns.push({
      id: "remove",
      header: t("never_contact.columns.remove"),
      cell: (list) =>
        list.removedAt === null && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("exclusions.remove.label", { name: list.name })}
            onClick={() => setRemoving(list)}
          >
            <Trash2 aria-hidden="true" />
            {t("exclusions.remove.action")}
          </Button>
        ),
    });
  }

  let lists: ReactNode;
  if (failure !== undefined) {
    lists = (
      <div className="grid gap-3">
        <p className="font-medium text-ink">{t("exclusions.error")}</p>
        <ErrorState module="contacts" code={failure.code} onRetry={() => read(failure.cursors)} />
      </div>
    );
  } else if (shown === undefined) {
    lists = (
      <div className="grid gap-3">
        <p role="status" className="wt-loading-state text-sm">
          <span className="wt-spinner" aria-hidden="true" />
          {t("exclusions.loading")}
        </p>
        <Skeleton shape="table" lines={LOADING_ROWS} />
      </div>
    );
  } else {
    const { cursors, next } = shown;
    lists = (
      <div
        aria-busy={busy || undefined}
        className="transition-opacity duration-150 aria-busy:opacity-60"
      >
        <DataTable
          caption={t("exclusions.caption")}
          columns={columns}
          rows={shown.lists}
          pager={{
            onPrevious: cursors.length > 0 ? () => read(cursors.slice(0, -1)) : undefined,
            onNext: next ? () => read([...cursors, next]) : undefined,
          }}
          empty={<EmptyState message={t("exclusions.empty")} />}
        />
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mb-8 grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id={`${id}-title`} className="font-semibold text-ink">
        {t("exclusions.title")}
      </h2>
      <p className="text-pretty text-ink-muted">{t("exclusions.description")}</p>
      <form onSubmit={submit} className="grid justify-items-start gap-4">
        <div className="flex w-full flex-wrap items-start gap-4">
          <div className="w-full sm:w-64">
            <Select
              label={t("exclusions.relationship")}
              value={relationship}
              onChange={(event) => setRelationship(event.target.value as SuppressionRelationship)}
              options={[
                { value: "customer", label: relationshipText.customer },
                { value: "competitor", label: relationshipText.competitor },
              ]}
            />
          </div>
          <div className="grid min-w-0 flex-1 basis-80 gap-2">
            <label htmlFor={`${id}-file`} className="text-sm font-medium text-ink">
              {t("exclusions.file")}
            </label>
            <input
              ref={picker}
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              disabled={importing !== undefined}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setProblem(undefined);
              }}
              className="min-w-0 max-w-full text-sm text-ink-muted file:me-3 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium file:text-ink disabled:opacity-60"
            />
          </div>
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={file === undefined}
          loading={importing !== undefined}
        >
          <FileUp aria-hidden="true" />
          {t("exclusions.submit")}
        </Button>
      </form>
      <p role="status" className="flex min-h-5 items-center gap-2 text-sm text-ink">
        {importing !== undefined && <span className="wt-spinner" aria-hidden="true" />}
        {importing !== undefined
          ? t("exclusions.importing", { file: importing })
          : result &&
            t("exclusions.result", {
              added: result.added,
              duplicates: result.duplicates,
              invalid: result.list.invalidCount,
            })}
      </p>
      {problem !== undefined && <ErrorState module="contacts" code={problem} />}
      {result !== undefined && result.invalid.length > 0 && (
        <div className="grid gap-1.5">
          <h3 className="text-sm font-medium text-ink">{t("exclusions.rows")}</h3>
          <ul className="grid gap-1 text-sm text-ink-muted">
            {result.invalid.map(({ row, code }) => (
              <li key={row}>{rowText[code](format.number(row))}</li>
            ))}
          </ul>
        </div>
      )}
      {removeFailed !== undefined && <ErrorState module="contacts" code={removeFailed} />}
      {lists}
      <Dialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={t("exclusions.remove.title", { name: removing?.name ?? "" })}
        actions={
          <Button variant="danger" onClick={() => removing && remove(removing)}>
            {t("exclusions.remove.action")}
          </Button>
        }
      >
        <p className="my-3">{t("exclusions.remove.body")}</p>
      </Dialog>
    </section>
  );
}
