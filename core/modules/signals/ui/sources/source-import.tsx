"use client";
// The import of a CSV file of sources (README.md "Importing sources"; sources-csv-import), a card under
// the add form that its "Import sources from a CSV" opens: the sender account, as the form picks it,
// and the file, beside the columns and the sample file. A file picked is checked at once, its size
// read first, and checked again when the account changes: the check's figures, the rows to import and
// those with an error, which a link saves as a CSV; then "Import the valid rows", and the import's
// result in place of the check: the sources created, those created disabled past the limits, and the
// rows not imported. Each row's code in words, with the file's columns it names. The file travels in
// base64, as the routes take it.
import { Button, type Column, DataTable, ErrorState, Link, Select } from "@whytide/ui";
import { CircleCheck, Download, FileSpreadsheet, Import, X } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type ChangeEvent, type ReactNode, useId, useState } from "react";
import {
  SOURCE_IMPORT_MAX_BYTES,
  SOURCE_IMPORT_MAX_MEGABYTES,
  SOURCE_IMPORT_MAX_ROWS,
} from "../../domain/import/constants.ts";
import { firstChoice } from "./add-source-form.tsx";
import { errorRows, type RowError, SAMPLE_FILE, SAMPLE_HREF } from "./downloads.ts";
import type { Account } from "./source-list.tsx";

type Body = { fileName: string; file: string; senderAccountId: string };
type Checked = {
  fileName: string;
  rows: number;
  valid: { row: number; kind: string; label: string }[];
  errors: RowError[];
};
type Imported = {
  sourceImport: { fileName: string; created: number; disabled: number; refused: number };
  errors: RowError[];
};
type Busy = { readonly step: "checking" | "importing"; readonly file: string };

/** The file's bytes in base64, as a data: URL carries them after its comma. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function SourceImport(props: {
  workspaceId: string;
  accounts: Account[];
  /** Reads the screen again, once sources are imported. */
  onImported: () => Promise<void>;
  onClose: () => void;
}) {
  const { workspaceId, accounts, onImported, onClose } = props;
  const t = useTranslations("signals");
  const id = useId();
  const [account, setAccount] = useState(() => firstChoice(accounts));
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState<Busy>();
  const [checked, setChecked] = useState<Checked>();
  const [imported, setImported] = useState<Imported>();
  const [problem, setProblem] = useState<string>();
  const params = { path: { workspaceId } };

  /** One request on the file, busy meanwhile; a refusal of the file shows its code. */
  async function send(which: Busy["step"], picked: File, run: (body: Body) => Promise<void>) {
    setProblem(undefined);
    setChecked(undefined);
    setImported(undefined);
    // The api's limit, checked before any request; the api refuses a larger file all the same.
    if (picked.size > SOURCE_IMPORT_MAX_BYTES) return setProblem("signal_import_too_large");
    setBusy({ step: which, file: picked.name });
    try {
      await run({ fileName: picked.name, file: await base64Of(picked), senderAccountId: account });
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : "internal_error");
    } finally {
      setBusy(undefined);
    }
  }

  const check = (picked: File, senderAccountId: string) =>
    send("checking", picked, async (body) => {
      const path = "/v1/workspaces/{workspaceId}/signals/sources/imports/check";
      setChecked(
        await data(browserApi().POST(path, { params, body: { ...body, senderAccountId } })),
      );
    });

  const runImport = (picked: File) =>
    send("importing", picked, async (body) => {
      const path = "/v1/workspaces/{workspaceId}/signals/sources/imports";
      setImported(await data(browserApi().POST(path, { params, body })));
      await onImported();
    });

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    // So that the same file, picked again after a change, is checked again.
    event.target.value = "";
    if (picked === undefined) return;
    setFile(picked);
    void check(picked, account);
  }

  const status =
    busy === undefined
      ? ""
      : busy.step === "checking"
        ? t("source_imports.checking", { file: busy.file })
        : t("source_imports.importing", { file: busy.file });
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid gap-5 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <header className="flex items-start justify-between gap-3">
        <h2 id={`${id}-title`} className="font-semibold text-ink">
          {t("source_imports.title")}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={t("source_imports.close")}>
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="grid content-start gap-4 [&_.wt-field]:min-w-0">
          <Select
            label={t("sources.account")}
            value={account}
            disabled={busy !== undefined}
            onChange={(event) => {
              setAccount(event.target.value);
              if (file) void check(file, event.target.value);
            }}
            options={accounts.map(({ id: value, label }) => ({ value, label }))}
          />
          <div className="grid gap-2">
            <label htmlFor={`${id}-file`} className="text-sm font-medium text-ink">
              {t("source_imports.file")}
            </label>
            <input
              id={`${id}-file`}
              type="file"
              accept=".csv,text/csv"
              aria-describedby={`${id}-limit`}
              disabled={busy !== undefined}
              onChange={pick}
              className="min-w-0 max-w-full text-sm text-ink-muted file:me-3 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium file:text-ink disabled:opacity-60"
            />
            <p id={`${id}-limit`} className="text-pretty text-xs text-ink-muted">
              {t("source_imports.limit", {
                megabytes: SOURCE_IMPORT_MAX_MEGABYTES,
                rows: SOURCE_IMPORT_MAX_ROWS,
              })}
            </p>
          </div>
          <p role="status" className="flex min-h-5 items-center gap-2 text-sm text-ink-muted">
            {busy ? <span className="wt-spinner" aria-hidden="true" /> : null}
            {status}
          </p>
          {problem ? <ErrorState module="signals" code={problem} /> : null}
        </div>
        <div className="grid content-start gap-3 rounded-lg bg-muted/60 p-4">
          <p className="text-pretty text-ink-muted">{t("source_imports.columns")}</p>
          <p className="text-pretty text-ink-muted">{t("source_imports.every_row")}</p>
          <p>
            <Link href={SAMPLE_HREF} download={SAMPLE_FILE}>
              <Download aria-hidden="true" className="me-1.5 inline size-4 align-[-0.2em]" />
              {t("source_imports.sample")}
            </Link>
          </p>
        </div>
      </div>
      {checked ? (
        <CheckReport checked={checked}>
          {checked.valid.length > 0 && file ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button variant="primary" onClick={() => runImport(file)}>
                <Import aria-hidden="true" />
                {t("source_imports.run")}
              </Button>
            </div>
          ) : (
            <p className="rounded-lg bg-danger-soft px-3.5 py-3 text-pretty text-danger-ink">
              {t("source_imports.none_valid")}
            </p>
          )}
        </CheckReport>
      ) : null}
      {imported ? <ImportResult imported={imported} /> : null}
    </section>
  );
}

/** A figure: the term that names it, its number, and whether a number above zero went wrong. */
type Figure = readonly [term: string, value: number, wrong?: boolean];

/** Counts as tiles: each number after the term that names it. */
function Figures({ items }: { items: readonly Figure[] }) {
  const format = useFormatter();
  return (
    <dl className="grid grid-cols-3 gap-2">
      {items.map(([term, value, wrong]) => (
        <div key={term} className="grid content-start gap-1 rounded-lg bg-muted/60 px-3.5 py-3">
          <dt className="text-xs font-medium text-ink-muted">{term}</dt>
          <dd
            className={`text-2xl font-semibold tracking-tight tabular-nums ${wrong && value > 0 ? "text-danger-ink" : "text-ink"}`}
          >
            {format.number(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The rows not imported, each code in words with its columns, and the link that saves them. */
function RowErrors({ fileName, errors }: { fileName: string; errors: RowError[] }) {
  const t = useTranslations("signals.source_imports");
  const format = useFormatter();
  const words: Record<string, string> = {
    signal_kind_unknown: t("problems.signal_kind_unknown"),
    signal_config_invalid: t("problems.signal_config_invalid"),
    signal_topic_blocked: t("problems.signal_topic_blocked"),
    signal_post_link_unreachable: t("problems.signal_post_link_unreachable"),
    duplicate_in_file: t("problems.duplicate_in_file"),
    source_exists: t("problems.source_exists"),
  };
  type Line = RowError & { id: string };
  const columns: Column<Line>[] = [
    { id: "row", header: t("row"), cell: (line) => format.number(line.row) },
    { id: "column", header: t("column"), cell: (line) => format.list(line.columns) },
    {
      id: "problem",
      header: t("problem"),
      cell: (line) => words[line.code] ?? t("problems.other"),
    },
  ];
  const download = errorRows(fileName, errors);
  return (
    <div className="grid gap-3">
      <DataTable
        caption={t("errors_table")}
        columns={columns}
        rows={errors.map((line) => ({ ...line, id: `${line.row}` }))}
      />
      <p>
        <Link href={download.href} download={download.file}>
          <Download aria-hidden="true" className="me-1.5 inline size-4 align-[-0.2em]" />
          {t("download_errors")}
        </Link>
      </p>
    </div>
  );
}

/** A part's heading after its icon. */
function Heading(props: { id: string; done?: boolean; children: ReactNode }) {
  const Icon = props.done ? CircleCheck : FileSpreadsheet;
  const tile = props.done ? "bg-success-soft text-success-ink" : "bg-accent-soft text-accent-ink";
  return (
    <header className="flex items-center gap-3">
      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${tile}`}>
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <h3 id={props.id} className="min-w-0 font-semibold text-ink wrap-anywhere">
        {props.children}
      </h3>
    </header>
  );
}

/** The check: its figures, the rows to import with their kind and label, the rows with an error. */
function CheckReport({ checked, children }: { checked: Checked; children: ReactNode }) {
  const t = useTranslations("signals");
  const format = useFormatter();
  const id = useId();
  const kinds: Record<string, string> = {
    post_engagers: t("kinds.post_engagers.label"),
    topic_engagement: t("kinds.topic_engagement.label"),
    competitor_engagement: t("kinds.competitor_engagement.label"),
    creator_engagement: t("kinds.creator_engagement.label"),
  };
  type Line = Checked["valid"][number] & { id: string };
  const columns: Column<Line>[] = [
    { id: "row", header: t("source_imports.row"), cell: (line) => format.number(line.row) },
    { id: "kind", header: t("source_imports.kind"), cell: (line) => kinds[line.kind] ?? line.kind },
    {
      id: "label",
      header: t("source_imports.label"),
      cell: (line) => <span className="wrap-anywhere">{line.label}</span>,
    },
  ];
  const figures: Figure[] = [
    [t("source_imports.rows"), checked.rows],
    [t("source_imports.valid"), checked.valid.length],
    [t("source_imports.with_errors"), checked.errors.length, true],
  ];
  return (
    <section aria-labelledby={id} className="grid gap-5 border-t border-line pt-5">
      <Heading id={id}>{t("source_imports.check_title", { file: checked.fileName })}</Heading>
      <Figures items={figures} />
      {checked.valid.length > 0 ? (
        <DataTable
          caption={t("source_imports.valid_table")}
          columns={columns}
          rows={checked.valid.map((line) => ({ ...line, id: `${line.row}` }))}
        />
      ) : null}
      {checked.errors.length > 0 ? (
        <RowErrors fileName={checked.fileName} errors={checked.errors} />
      ) : null}
      {children}
    </section>
  );
}

/** The import: the sources created, those created disabled and why, the rows not imported. */
function ImportResult({ imported }: { imported: Imported }) {
  const t = useTranslations("signals.source_imports");
  const id = useId();
  const { fileName, created, disabled, refused } = imported.sourceImport;
  const figures: Figure[] = [
    [t("created"), created],
    [t("disabled"), disabled],
    [t("refused"), refused, true],
  ];
  return (
    <section aria-labelledby={id} className="grid gap-5 border-t border-line pt-5">
      <Heading id={id} done>
        {t("result_title", { file: fileName })}
      </Heading>
      <Figures items={figures} />
      {disabled > 0 ? (
        <p className="rounded-lg bg-warm-soft px-3.5 py-3 text-pretty text-warm-ink">
          {t("disabled_note", { count: disabled })}
        </p>
      ) : null}
      {imported.errors.length > 0 ? (
        <RowErrors fileName={fileName} errors={imported.errors} />
      ) : null}
    </section>
  );
}
