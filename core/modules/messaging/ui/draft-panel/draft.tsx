// One draft in the panel (drafts.tsx). The newest: its mark, the progress while it is written, the
// stale note with the Regenerate hint when it was written on another dossier than today's, a flagged
// draft's reasons, a failed one's code in words; then the message as the person will read it, a
// bubble on its channel, with a counter and a bar against the channel's limit (a message's also says
// the range it aims for), shimmering while the writer runs; Copy for a ready or edited one; Edit, a
// text area whose counter turns to the danger colour above the limit, where Save refuses it;
// Regenerate; beside each other on a wide panel, the plan, its angle, call to action and facts with
// their sources, loading while the browser reads them, and the gates, pass or fail with their
// reasons, which belong to the generated text, an edit being unchecked. In the history, on a
// timeline: its channel, time, mark and text, and its model and prompt version while it is hovered
// or its time has the keyboard's focus. An email's subject above its body (gamma-p3-070).
"use client";

import { Badge, type BadgeTone, Button, Meter, Skeleton, TextArea } from "@whytide/ui";
import {
  CircleCheck,
  CircleX,
  Copy,
  Flag,
  History,
  type LucideIcon,
  Mail,
  MessageCircleQuestion,
  MessageSquare,
  PenLine,
  RefreshCw,
  Target,
  TriangleAlert,
  UserPlus,
} from "@whytide/ui/icons";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { MESSAGE_RANGE } from "../../domain/gates/range.ts";
import { gateIssueText } from "../gates.ts";
import { WRITING_LINES } from "./constants.ts";
import type { Draft, Fact } from "./panel.tsx";
import { useDraftWords } from "./words.ts";

/** The facts the plan cites in its order; being read; or of another dossier than today's. */
export type Facts = Fact[] | "reading" | "stale";
type Props = {
  draft: Draft;
  facts: Facts | undefined;
  /** A draft is being written: no Regenerate until it ends. */
  writing: boolean;
  regenerating: boolean;
  onCopy: (text: string) => void;
  onSave: (editedText: string) => Promise<boolean>;
  onRegenerate: () => void;
};

/** Each channel's icon, beside its words: an invitation's note, a message, or an email. */
export const CHANNEL_ICON: Record<Draft["channel"], LucideIcon> = {
  linkedin_note: UserPlus,
  linkedin_message: MessageSquare,
  email: Mail,
};
/** A mark's colour and icon, beside its words: being written, flagged, failed or edited. */
const MARK: Record<Draft["status"], [tone: BadgeTone, Icon: LucideIcon | undefined]> = {
  drafting: ["accent", undefined],
  ready: ["success", undefined],
  flagged: ["warning", Flag],
  failed: ["danger", CircleX],
  edited: ["neutral", PenLine],
  approved: ["success", undefined],
};
const NOTE = "flex items-start gap-2 rounded-lg px-3 py-2.5";
const ICON = "mt-0.5 size-4 shrink-0";
const HEADING = "text-sm font-semibold text-ink";

/** A text's length as the api counts it: UTF-16 units, as a textarea counts them, trimmed. */
const lengthOf = (text: string) => text.trim().length;
/** An email's subject, the member's else the writer's; null for none. */
const subjectOf = (draft: Draft) => draft.editedSubject ?? draft.subject;

/** A draft's mark as a badge in its colour, with its icon; none for a ready one. */
function Mark({ status }: { status: Draft["status"] }) {
  const mark = useDraftWords().mark[status];
  const [tone, Icon] = MARK[status];
  if (mark === undefined) return null;
  return (
    <Badge tone={tone}>
      {Icon && <Icon aria-hidden="true" />}
      {mark}
    </Badge>
  );
}

export function CurrentDraft(props: Props) {
  const { draft, facts, writing, regenerating, onCopy, onSave, onRegenerate } = props;
  const t = useTranslations("messaging.draft");
  const words = useDraftWords();
  const full = useTranslations();
  const format = useFormatter();
  const ids = { plan: useId(), facts: useId(), gates: useId(), reasons: useId() };
  const [editing, setEditing] = useState<string>();
  const [saving, setSaving] = useState(false);
  const shown = draft.editedText ?? draft.text;
  const subject = subjectOf(draft);
  const max = draft.maxCharacters;
  /** The count against the limit; a message's with the range its writer aims for. */
  const counter = (text: string) =>
    draft.channel === "linkedin_message"
      ? t("range", { count: lengthOf(text), max, low: MESSAGE_RANGE.min, high: MESSAGE_RANGE.max })
      : t("counter", { count: lengthOf(text), max });
  const over = (text: string) => lengthOf(text) > max;
  const copyable = draft.status === "ready" || draft.status === "edited";
  const Channel = CHANNEL_ICON[draft.channel];

  async function save() {
    if (editing === undefined) return;
    setSaving(true);
    const saved = await onSave(editing.trim());
    setSaving(false);
    if (saved) setEditing(undefined);
  }

  return (
    <div data-part="draft" className="grid gap-4 [&_.wt-field]:min-w-0">
      {draft.status === "drafting" ? (
        <p role="status" className="wt-loading-state text-sm">
          <span className="wt-spinner" aria-hidden="true" />
          {t("drafting")}
        </p>
      ) : (
        words.mark[draft.status] && (
          <p id={ids.reasons} className="flex">
            <Mark status={draft.status} />
          </p>
        )
      )}
      {facts === "stale" && (
        <p className={`${NOTE} border border-warm-dot/30 bg-warm-soft text-warm-ink`}>
          <History aria-hidden="true" className={ICON} />
          {t("stale")}
        </p>
      )}
      {draft.status === "flagged" && (
        <ul
          aria-labelledby={ids.reasons}
          className="grid gap-1.5 rounded-lg border border-warm-dot/30 bg-warm-soft px-3 py-2.5 text-warm-ink"
        >
          {draft.flagReasons.map((reason, index) =>
            "gate" in reason ? (
              <li key={index} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className={ICON} />
                {gateIssueText(full, reason)}
              </li>
            ) : null,
          )}
        </ul>
      )}
      {draft.status === "failed" &&
        draft.flagReasons.flatMap((reason, index) => {
          const why = "code" in reason ? words.failure(reason.code) : undefined;
          return why === undefined
            ? []
            : [
                <p key={index} className={`${NOTE} bg-danger-soft text-danger-ink`}>
                  <CircleX aria-hidden="true" className={ICON} />
                  {why}
                </p>,
              ];
        })}
      {editing === undefined ? (
        (shown !== null || draft.status === "drafting") && (
          // The message as the person will read it, on its channel; a shimmer while it is written.
          <div className="grid gap-3 rounded-xl bg-canvas p-3 ring-1 ring-line ring-inset sm:p-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
              <Channel aria-hidden="true" className="size-3.5 shrink-0" />
              {words.channel[draft.channel]}
            </p>
            {shown === null ? (
              <div className="max-w-md rounded-2xl rounded-es-md bg-surface px-4 py-3.5 shadow-xs ring-1 ring-line">
                <Skeleton lines={WRITING_LINES} />
              </div>
            ) : (
              <>
                {subject !== null && (
                  <p className="max-w-prose font-semibold wrap-break-word text-ink">
                    {t("subject", { subject })}
                  </p>
                )}
                <p className="max-w-prose rounded-2xl rounded-es-md bg-surface px-4 py-3 text-[0.9375rem] leading-relaxed wrap-break-word whitespace-pre-wrap text-ink shadow-xs ring-1 ring-line">
                  {shown}
                </p>
                <div className="flex items-center gap-3">
                  <p
                    className={`min-w-0 flex-1 text-xs tabular-nums ${over(shown) ? "font-medium text-danger-ink" : "text-ink-muted"}`}
                  >
                    {counter(shown)}
                  </p>
                  <span className="w-16 shrink-0 sm:w-24">
                    <Meter
                      value={lengthOf(shown)}
                      max={max}
                      tone={over(shown) ? "hot" : "accent"}
                    />
                  </span>
                </div>
              </>
            )}
          </div>
        )
      ) : (
        <TextArea
          label={t("text")}
          rows={6}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          {...(over(editing) ? { error: counter(editing) } : { hint: counter(editing) })}
        />
      )}
      {editing === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          {shown !== null && copyable && (
            <Button variant="primary" onClick={() => onCopy(shown)}>
              <Copy aria-hidden="true" />
              {t("copy")}
            </Button>
          )}
          {shown !== null && (
            <Button onClick={() => setEditing(shown)}>
              <PenLine aria-hidden="true" />
              {t("edit")}
            </Button>
          )}
          <div className="ms-auto">
            <Button loading={regenerating} disabled={writing} onClick={onRegenerate}>
              {!regenerating && <RefreshCw aria-hidden="true" />}
              {t("regenerate")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={saving}
            disabled={over(editing) || lengthOf(editing) === 0}
            onClick={save}
          >
            {t("save")}
          </Button>
          <Button onClick={() => setEditing(undefined)}>{t("cancel")}</Button>
        </div>
      )}
      {(draft.plan || draft.gates.length > 0) && (
        <div className="grid gap-5 border-t border-line pt-4 @xl:grid-cols-2 @xl:gap-6">
          {draft.plan && (
            <div className="grid content-start gap-3">
              <h3 id={ids.plan} className={HEADING}>
                {t("plan")}
              </h3>
              <ul aria-labelledby={ids.plan} className="grid gap-2 text-ink">
                <li className="flex items-start gap-2.5">
                  <Target aria-hidden="true" className={`${ICON} text-accent-ink`} />
                  {words.angle[draft.plan.angle]}
                </li>
                <li className="flex items-start gap-2.5">
                  <MessageCircleQuestion aria-hidden="true" className={`${ICON} text-accent-ink`} />
                  {words.cta[draft.plan.cta]}
                </li>
              </ul>
              {facts !== "stale" && (
                <h4 id={ids.facts} className={`${HEADING} mt-1`}>
                  {t("facts")}
                </h4>
              )}
              {facts === "reading" && (
                <p role="status" className="wt-loading-state text-sm">
                  <span className="wt-spinner" aria-hidden="true" />
                  {t("loading")}
                </p>
              )}
              {Array.isArray(facts) && (
                <ul aria-labelledby={ids.facts} className="grid gap-2">
                  {facts.map(({ id, kind, value, sourceRef }) => (
                    <li key={id} className="grid gap-0.5 rounded-lg bg-muted px-3 py-2">
                      <q className="font-medium wrap-break-word text-ink">
                        {kind === "date"
                          ? format.dateTime(new Date(value), { dateStyle: "medium" })
                          : value}
                      </q>{" "}
                      <span className="text-xs text-ink-muted">{words.source(sourceRef)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {draft.gates.length > 0 && (
            <div className="grid content-start gap-3">
              <h3 id={ids.gates} className={HEADING}>
                {t("gates")}
              </h3>
              {draft.status === "edited" && (
                <p className="text-xs text-ink-muted">{t("gates_generated")}</p>
              )}
              <ul aria-labelledby={ids.gates} className="grid gap-2">
                {draft.gates.map(({ gate, issues }) => {
                  const passed = issues.length === 0;
                  const Icon = passed ? CircleCheck : CircleX;
                  return (
                    <li key={gate} className="grid gap-1">
                      <span
                        className={`flex items-start gap-2 ${passed ? "text-ink-muted" : "font-medium text-ink"}`}
                      >
                        <Icon
                          aria-hidden="true"
                          className={`${ICON} ${passed ? "text-success-ink" : "text-danger-ink"}`}
                        />
                        {t("gate_result", {
                          gate: words.gate[gate],
                          result: passed ? "passed" : "failed",
                        })}
                      </span>
                      {!passed && (
                        <ul className="grid gap-1 ps-6 text-sm text-danger-ink">
                          {issues.map((issue, index) => (
                            <li key={index}>{gateIssueText(full, issue)}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A draft in the history: its channel, when it was asked for, its mark and its text; its model and
 * prompt version, once written, in a hint that its time takes the keyboard's focus for.
 */
export function HistoryItem({ draft }: { draft: Draft }) {
  const t = useTranslations("messaging.draft");
  const words = useDraftWords();
  const format = useFormatter();
  const hint = useId();
  const shown = draft.editedText ?? draft.text;
  const subject = subjectOf(draft);
  const { modelId, promptVersion } = draft;
  const Channel = CHANNEL_ICON[draft.channel];
  const at = format.dateTime(new Date(draft.createdAt), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const time = <time dateTime={draft.createdAt}>{at}</time>;
  return (
    <li className="group/item relative grid gap-1.5 ps-5 before:absolute before:start-0 before:top-1.5 before:size-2 before:rounded-full before:bg-line-strong first:before:bg-accent">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        <Badge>
          <Channel aria-hidden="true" />
          {words.channel[draft.channel]}
        </Badge>
        {modelId === null || promptVersion === null ? (
          time
        ) : (
          // Right under the time, inside the item, whose hover shows it: the pointer reaches it across
          // its padding, which leaves no gap, and the item keeps it while the pointer is on it.
          <span className="group/when relative">
            <span
              tabIndex={0}
              aria-describedby={hint}
              className="cursor-help rounded-xs underline decoration-ink-subtle decoration-dotted underline-offset-2"
            >
              {time}
            </span>
            <span
              id={hint}
              role="tooltip"
              className="absolute start-0 top-full z-10 hidden w-max max-w-72 pt-1.5 group-hover/item:block group-focus-within/when:block"
            >
              <span className="block rounded-lg bg-ink px-2.5 py-1.5 font-medium text-surface shadow-md">
                {t("model_info", { model: modelId, version: promptVersion })}
              </span>
            </span>
          </span>
        )}
        <Mark status={draft.status} />
      </p>
      {subject !== null && (
        <p className="font-medium wrap-break-word text-ink">{t("subject", { subject })}</p>
      )}
      {shown !== null && (
        <p className="wrap-break-word whitespace-pre-wrap text-pretty text-ink-muted">{shown}</p>
      )}
    </li>
  );
}
