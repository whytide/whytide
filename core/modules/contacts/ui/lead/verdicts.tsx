// The lead page's verdicts per criterion (README.md "Screens"; lead-verdict-edit): qualification's
// verdict that counts for each criterion, with its evidence and weight, and an Edit on each row. A
// member's verdict says who set it (you or a teammate: contacts names no teammate) and when, its note,
// and the model's verdict in its words; a criterion without a verdict offers Add. Edit opens a dialog:
// the four verdicts, a note, Save, Cancel, and "Use the model's verdict" when a member's is set. Save
// sends qualification's PUT …/verdicts/{criterion} (the clear, its DELETE) through the web's client;
// the page then reads itself again (`router.refresh()`), so the status, the tier and the why show the
// new decision without a reload. A refusal shows in the dialog, its code in words.
"use client";

import {
  Badge,
  type BadgeTone,
  Button,
  type Column,
  DataTable,
  Dialog,
  ErrorState,
  Select,
  TextArea,
  useKeyText,
} from "@whytide/ui";
import {
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  type LucideIcon,
  Pencil,
  Plus,
} from "@whytide/ui/icons";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { startTransition, useState } from "react";
import { VERDICT_NOTE_MAX, VERDICTS } from "./constants.ts";
import type { Snapshot } from "./page.tsx";

type VerdictRow = Snapshot["verdicts"][number] & { id: string };
/** The answer's verdicts, which VERDICTS lists: a verdict it lacks fails the type check. */
type Verdict = NonNullable<VerdictRow["verdict"]> & (typeof VERDICTS)[number];

/** Each verdict's colour and icon, beside its words. */
const LOOK: Record<Verdict, [tone: BadgeTone, Icon: LucideIcon]> = {
  met: ["success", CircleCheck],
  partially_met: ["warning", CircleDot],
  not_met: ["danger", CircleX],
  unknown: ["neutral", CircleHelp],
};

export function Verdicts(props: {
  workspace: string;
  personId: string;
  verdicts: Snapshot["verdicts"];
}) {
  const { workspace, personId, verdicts } = props;
  const t = useTranslations("contacts.lead");
  const format = useFormatter();
  const keyText = useKeyText();
  const [editing, setEditing] = useState<VerdictRow>();
  const criterionText = (criterion: string) => keyText(`qualification.criterion.${criterion}`);
  const verdictText = (verdict: string) => keyText(`qualification.verdict.${verdict}`);
  const columns: Column<VerdictRow>[] = [
    {
      id: "criterion",
      header: t("criterion"),
      cell: ({ criterion }) => <span className="text-ink">{criterionText(criterion)}</span>,
    },
    {
      id: "verdict",
      header: t("verdict"),
      cell: ({ verdict, modelVerdict, member }) => {
        if (verdict === null) return <span className="text-ink-muted">{t("verdict_none")}</span>;
        const [tone, Icon] = LOOK[verdict] ?? LOOK.unknown;
        const badge = (
          <Badge tone={tone}>
            <Icon aria-hidden="true" />
            {verdictText(verdict)}
          </Badge>
        );
        if (member === null) return badge;
        const when = format.dateTime(new Date(member.setAt), { dateStyle: "medium" });
        return (
          <span className="grid justify-items-start gap-1">
            {badge}
            <span className="text-xs text-ink-muted">
              {t("verdict_set_by", { who: member.mine ? "you" : "teammate", when })}
            </span>
            {member.note && <q className="text-xs text-ink">{member.note}</q>}
            <span className="text-xs text-ink-muted">
              {modelVerdict === null
                ? t("verdict_model_none")
                : t("verdict_model", { verdict: verdictText(modelVerdict) ?? "" })}
            </span>
          </span>
        );
      },
    },
    {
      id: "evidence",
      header: t("evidence"),
      cell: ({ evidence }) => evidence && <q>{evidence}</q>,
    },
    {
      id: "weight",
      header: t("weight"),
      cell: ({ weight }) => (weight === null ? null : format.number(weight)),
    },
    {
      id: "edit",
      header: t("verdict_change"),
      cell: (row) => {
        const criterion = criterionText(row.criterion) ?? row.criterion;
        const adding = row.verdict === null;
        return (
          <Button
            size="sm"
            variant="ghost"
            aria-label={
              adding
                ? t("verdict_add_label", { criterion })
                : t("verdict_edit_label", { criterion })
            }
            onClick={() => setEditing(row)}
          >
            {adding ? <Plus aria-hidden="true" /> : <Pencil aria-hidden="true" />}
            {adding ? t("verdict_add") : t("verdict_edit")}
          </Button>
        );
      },
    },
  ];
  return (
    <>
      <DataTable
        caption={t("verdicts")}
        columns={columns}
        rows={verdicts.map((verdict) => ({ ...verdict, id: verdict.criterion }))}
      />
      {editing && (
        <VerdictDialog
          key={editing.criterion}
          workspace={workspace}
          personId={personId}
          row={editing}
          criterion={criterionText(editing.criterion) ?? editing.criterion}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

/** The dialog of one criterion's verdict: Save sets the member's, "Use the model's" clears it. */
function VerdictDialog(props: {
  workspace: string;
  personId: string;
  row: VerdictRow;
  criterion: string;
  onClose: () => void;
}) {
  const { workspace, personId, row, criterion, onClose } = props;
  const t = useTranslations("contacts.lead");
  const save = useTranslations("ui.action");
  const keyText = useKeyText();
  const router = useRouter();
  const [verdict, setVerdict] = useState<Verdict>(row.member?.verdict ?? row.verdict ?? "met");
  const [note, setNote] = useState(row.member?.note ?? "");
  const [busy, setBusy] = useState<"set" | "clear">();
  const [failure, setFailure] = useState<string>();

  async function send(kind: "set" | "clear") {
    setBusy(kind);
    setFailure(undefined);
    try {
      const path = { workspaceId: workspace, personId, criterion: row.criterion };
      const route =
        "/v1/workspaces/{workspaceId}/qualification/leads/{personId}/verdicts/{criterion}";
      const answer =
        kind === "set"
          ? await browserApi().PUT(route, {
              params: { path },
              body: { verdict, ...(note.trim() ? { note } : {}) },
            })
          : await browserApi().DELETE(route, { params: { path } });
      if (!answer.response.ok) {
        setFailure(new ApiError(answer.response.status, answer.error).code);
        return;
      }
      onClose();
      startTransition(() => router.refresh());
    } catch {
      setFailure("internal_error");
    } finally {
      setBusy(undefined);
    }
  }

  const model =
    row.modelVerdict === null
      ? t("verdict_model_none")
      : t("verdict_model", { verdict: keyText(`qualification.verdict.${row.modelVerdict}`) ?? "" });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("verdict_dialog_title", { criterion })}
      actions={
        <>
          {row.member && (
            <Button
              onClick={() => void send("clear")}
              loading={busy === "clear"}
              disabled={busy === "set"}
            >
              {t("verdict_use_model")}
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void send("set")}
            loading={busy === "set"}
            disabled={busy === "clear"}
          >
            {save("save")}
          </Button>
        </>
      }
    >
      <p>{model}</p>
      <div className="grid gap-4 pt-2">
        <Select
          label={t("verdict")}
          value={verdict}
          onChange={(event) => setVerdict(event.target.value as Verdict)}
          options={VERDICTS.map((value) => ({
            value,
            label: keyText(`qualification.verdict.${value}`) ?? value,
          }))}
        />
        <TextArea
          label={t("verdict_note")}
          hint={t("verdict_note_hint")}
          value={note}
          maxLength={VERDICT_NOTE_MAX}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
        />
        {failure && (
          <ErrorState
            module={failure === "lead_not_found" ? "contacts" : "qualification"}
            code={failure}
          />
        )}
      </div>
    </Dialog>
  );
}
