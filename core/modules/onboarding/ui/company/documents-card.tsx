// The documents' card of the Company screen (README "The documents"), a client component below the
// website's card: up to the record's documentLimits.files PDF, Markdown or text files of at most its
// documentLimits.bytes each (the api's settings, README "Settings": five and 10 MB unset), each read
// in the browser by the rules the script reads them by (domain/documents.ts), a PDF's text through
// unpdf, whose PDF.js loads only once a PDF is picked (it sets globals, so the api and the worker
// never load it), cut at 50,000 characters. Each file listed with its status or its refusal in
// words, and removable; Draft from documents sends the texts read with the Draft (draft-start.tsx),
// the website's pages read too when one is saved, and the website's card shows the run. No file
// leaves the browser, only the texts.
"use client";

import { Badge, Button, Card } from "@whytide/ui";
import { FileText, Sparkles, X } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useId, useState } from "react";
import { DOCUMENT_TYPES } from "../../domain/constants.ts";
import {
  type DocumentLimits,
  type DocumentRefusal,
  type DocumentResult,
  documentFromBytes,
  documentKind,
  isTooLarge,
} from "../../domain/documents.ts";
import { MEGABYTE } from "./constants.ts";
import { type DraftStartProps, useDraftStart } from "./draft-start.tsx";

/** A file picked: its name, then what reading it gave, its document or its refusal. */
type Picked = { readonly key: string; readonly name: string; readonly read?: DocumentResult };

/** The file picker's types: the extensions, and their media types for a picker that wants those. */
const ACCEPT = [...Object.keys(DOCUMENT_TYPES), ...Object.values(DOCUMENT_TYPES)].join(",");

/** A file's bytes at most in megabytes, as the messages say it: whole, or to two decimals at most. */
const megabytes = (bytes: number) => Math.round((bytes / MEGABYTE) * 100) / 100 || 0.01;

/** The file's document, read in the browser, or its refusal, in the script's order of checks. */
async function readFile(file: File, limits: DocumentLimits): Promise<DocumentResult> {
  const kind = documentKind(file.name);
  if (!kind.ok) return kind;
  if (isTooLarge(file.size, limits.bytes)) return { ok: false, code: "document_too_large" };
  try {
    // The file's own copy: PDF.js takes the array over.
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await documentFromBytes(file.name, kind.mediaType, bytes, () => import("unpdf"));
  } catch {
    return { ok: false, code: "document_unreadable" };
  }
}

export function DocumentsCard(props: DraftStartProps) {
  const t = useTranslations("onboarding.company.documents");
  const company = useTranslations("onboarding.company");
  const errors = useTranslations("onboarding.errors");
  const shared = useTranslations("ui");
  const id = useId();
  const limits = props.record.documentLimits;
  const shown = { files: limits.files, megabytes: megabytes(limits.bytes) };
  const [picked, setPicked] = useState<Picked[]>([]);
  const { press, starting, confirm, problem } = useDraftStart(props, t("draft"));
  const documents = picked.flatMap(({ read }) => (read?.ok ? [read.document] : []));
  const reading = picked.some(({ read }) => read === undefined);

  /** Lists the files picked, a sixth and a name twice refused at once; then reads each. */
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    // The same file may be picked again once removed.
    event.target.value = "";
    const listed = picked.filter(({ read }) => read?.ok !== false).map(({ name }) => name);
    const reads: [string, File][] = [];
    const added = files.map((file): Picked => {
      const key = crypto.randomUUID();
      const code =
        listed.length >= limits.files
          ? "documents_too_many"
          : listed.includes(file.name)
            ? "document_name_repeated"
            : null;
      if (code !== null) return { key, name: file.name, read: { ok: false, code } };
      listed.push(file.name);
      reads.push([key, file]);
      return { key, name: file.name };
    });
    setPicked((current) => [...current, ...added]);
    for (const [key, file] of reads) {
      void readFile(file, limits).then((read) =>
        setPicked((current) =>
          current.map((item) => (item.key === key ? { ...item, read } : item)),
        ),
      );
    }
  }

  /** The refusal in words: the script's codes. */
  const refusal = (code: DocumentRefusal) =>
    code === "document_type_unsupported"
      ? errors("document_type_unsupported")
      : code === "document_name_invalid"
        ? errors("document_name_invalid")
        : code === "document_too_large"
          ? errors("document_too_large", shown)
          : code === "document_no_text"
            ? errors("document_no_text")
            : code === "document_encrypted"
              ? errors("document_encrypted")
              : code === "documents_too_many"
                ? errors("documents_too_many", shown)
                : code === "document_name_repeated"
                  ? errors("document_name_repeated")
                  : errors("document_unreadable");

  return (
    <Card title={t("title")} description={t("hint", shown)}>
      <div data-part="documents" className="grid gap-4">
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-files`} className="text-sm font-medium text-ink">
            {t("pick")}
          </label>
          <input
            id={`${id}-files`}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={pick}
            className="min-w-0 max-w-full text-sm text-ink-muted file:me-3 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2 file:font-medium file:text-ink"
          />
        </div>
        {picked.length > 0 ? (
          <ul aria-label={t("list")} aria-live="polite" className="grid gap-2 contain-inline-size">
            {picked.map(({ key, name, read }) => (
              <li
                key={key}
                data-document={name}
                className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line bg-muted px-2.5 py-1.5"
              >
                <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-ink">{name}</span>
                  {read === undefined ? (
                    <span className="text-xs text-ink-muted">{t("reading")}</span>
                  ) : read.ok ? (
                    <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                      {t("read")}
                      {read.document.status === "truncated" ? (
                        <Badge tone="warning">{company("page_truncated")}</Badge>
                      ) : null}
                    </span>
                  ) : (
                    <span className="text-pretty text-xs text-danger-ink">
                      {refusal(read.code)}
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={shared("list.remove", { item: name })}
                  onClick={() => setPicked((current) => current.filter((item) => item.key !== key))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            onClick={() => press({ documents })}
            loading={starting}
            disabled={documents.length === 0 || reading}
          >
            <Sparkles aria-hidden="true" className="text-accent-ink" />
            {t("draft")}
          </Button>
          <p className="min-w-0 flex-1 basis-64 text-xs text-ink-muted">{t("draft_hint")}</p>
        </div>
        {confirm}
        {problem}
      </div>
    </Card>
  );
}
