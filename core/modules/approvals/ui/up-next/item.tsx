// One row of "Up next" (queue.tsx): the lead, their name linked to the lead page, title, company,
// tier and first why bullet, as the lead list shows them; the step's action and when it is due, in
// its sender's zone; the flags, stale, needs attention, drafting, draft failed, gate warning with the
// draft's issues, and waiting with its reason; the text with its counter against the draft's
// maxCharacters, or a spinner while it is being written; the facts it uses (facts.tsx); then Edit,
// Approve and Skip. Edit opens the text in a field held to the draft's limits, whose Approve sends
// what was typed; a failed draft opens it empty. A refused text shows each gate's issue and keeps
// what was typed. Skip asks first, and says that skipping a connection request ends the sequence.
// Approve and Skip send an Idempotency-Key per press, which Try again sends again; Approve sends the
// shown draft's id. Every row is the caller's own, its sender's owner's (gamma-p6-050): one the api
// says they may not decide would keep its decisions disabled. An email row (gamma-p4-090) names its
// mailbox and shows a first email's subject, edited beside the body within its limits; a row the
// campaign's mode will approve says so, with the channel's AI disclosure line (messaging's panel,
// given by the page), and one it left to its owner says why. In a sender's section (queue.tsx), its
// headings go one level down.
"use client";

import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Link,
  TextArea,
  TextField,
  type Tier,
  useKeyText,
} from "@whytide/ui";
import {
  AlarmClock,
  Bot,
  Check,
  CircleX,
  Clock,
  Flag,
  History,
  Hourglass,
  type LucideIcon,
  Mail,
  MessageSquare,
  PenLine,
  SkipForward,
  TriangleAlert,
  UserPlus,
} from "@whytide/ui/icons";
import { ApiError, browserApi, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { type ReactNode, useId, useRef, useState } from "react";
import { FALLBACK_TIME_ZONE, MODE_DECLINED } from "../../domain/items/constants.ts";
import type { ItemResponse } from "../../schemas/items.ts";
import { TIME_FORMAT } from "./constants.ts";
import { Facts } from "./facts.tsx";
import { type GateIssue, useUpNextWords } from "./words.ts";

/** The channels' AI disclosure lines, messaging's panel as the page rendered it for each. */
export type Lines = Readonly<Record<ItemResponse["channel"], ReactNode>>;
type Props = {
  workspace: string;
  item: ItemResponse;
  lines: Lines;
  /** In a sender's section, under its heading: the row's headings go one level down. */
  nested?: boolean;
  /** The decision done, in the toast's words: the queue reads itself again. */
  onDecided: (message: string) => void;
};
type Decision = "approve" | "skip";
/** What an Approve sends of what was typed: the body, a first email's subject, either or none. */
type Final = { readonly text?: string; readonly subject?: string };
/** A press the api refused: its answer, a refused text's issues, and the same press again. */
type Failure = {
  readonly error: ApiError;
  readonly issues: GateIssue[];
  readonly retry?: () => void;
};

/** A pending row whose draft its writer has not ended: none is attached yet. */
export const isDrafting = (item: ItemResponse) =>
  item.status === "pending" && (item.draft === null || item.draft.status === "drafting");
/** The zone a row's times are in: its sender account's, else the one the api counts days in. */
export const zoneOf = (item: ItemResponse) => item.sender?.timeZone ?? FALLBACK_TIME_ZONE;

/** The tiers a Badge draws; the lead's is an open string (README.md "Screen"). */
const TIERS: Record<Tier, true> = { hot: true, warm: true, cool: true };
const isTier = (tier: string | null | undefined): tier is Tier =>
  typeof tier === "string" && Object.hasOwn(TIERS, tier);
/** Each action's icon, beside its words: a connection request, a message or an email. */
const ACTION_ICON: Record<ItemResponse["actionType"], LucideIcon> = {
  invite: UserPlus,
  message: MessageSquare,
  email: Mail,
};
const REFUSED = "draft_text_refused";
const NOTE = "grid gap-1.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";

/** A text's length as the api counts it: UTF-16 units, as a textarea counts them, trimmed. */
const lengthOf = (text: string) => text.trim().length;
/** A subject's words, as messaging's gate counts them: runs of non-space characters. */
const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const isIssue = (reason: object): reason is GateIssue => "gate" in reason;
/** The gates' issues of a refused text, from the api's answer (`details.issues`). */
function issuesOf(body: unknown): GateIssue[] {
  const issues = (body as { details?: { issues?: unknown } } | undefined)?.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is GateIssue =>
      typeof issue === "object" && issue !== null && typeof issue.gate === "string",
  );
}

/** An Approve's typed parts: the body once the field is open, the subject once it was changed. */
const finalOf = (text: string | undefined, subject: string | undefined): Final => ({
  ...(text !== undefined && { text }),
  ...(subject !== undefined && { subject }),
});

export function Item({ workspace, item, lines, nested = false, onDecided }: Props) {
  const t = useTranslations("approvals.up_next");
  const words = useUpNextWords();
  const keyText = useKeyText();
  const messages = useMessages();
  const format = useFormatter();
  const nameId = useId();
  const Heading = nested ? "h4" : "h3";
  const { draft, lead } = item;
  const pending = item.status === "pending";
  const drafting = isDrafting(item);
  const failed = draft?.status === "failed";
  const [typed, setTyped] = useState<string>();
  const [subjectTyped, setSubjectTyped] = useState<string>();
  const [pressed, setPressed] = useState<Decision>();
  const [failure, setFailure] = useState<Failure>();
  const [skipping, setSkipping] = useState(false);
  const running = useRef(false);
  const name = words.name(lead);
  const tier = lead?.tier;
  const role = lead && words.role(lead);
  const why = lead?.why ? keyText(lead.why.key, lead.why.params) : undefined;
  // A failed draft has no text: its field is open and empty until the owner types one.
  const editing = typed ?? (pending && failed && item.canDecide ? "" : undefined);
  const issues = failure?.error.code === REFUSED ? failure.issues : undefined;
  const owner = failure && !issues ? errorOwner(failure.error, messages) : undefined;
  const flagged = draft?.status === "flagged" ? draft.flagReasons.filter(isIssue) : [];
  const Action = ACTION_ICON[item.actionType];
  const at = (time: string) =>
    format.dateTime(new Date(time), { ...TIME_FORMAT, timeZone: zoneOf(item) });
  const timed = (time: string) => (chunks: ReactNode) => <time dateTime={time}>{chunks}</time>;
  const max = draft?.maxCharacters ?? 0;
  const counter = (text: string) => t("counter", { count: lengthOf(text), max });
  const over = editing !== undefined && lengthOf(editing) > max;
  const short = editing !== undefined && lengthOf(editing) < (draft?.minCharacters ?? 0);
  const notes = over
    ? { error: counter(editing ?? "") }
    : { hint: counter(editing ?? ""), error: issues ? t("refused") : undefined };
  const decisions = item.canDecide ? {} : { disabled: true };
  // A first email's subject opens with its body, held to the draft's words and characters.
  const subject =
    editing !== undefined && draft?.subject != null ? (subjectTyped ?? draft.subject) : undefined;
  const subjectMax = {
    maxWords: draft?.maxSubjectWords ?? 0,
    max: draft?.maxSubjectCharacters ?? 0,
  };
  const subjectOff =
    subject !== undefined &&
    (lengthOf(subject) === 0 ||
      wordsOf(subject) > subjectMax.maxWords ||
      lengthOf(subject) > subjectMax.max);
  const subjectHint = (text: string) =>
    t("subject_counter", { words: wordsOf(text), count: lengthOf(text), ...subjectMax });
  const declined = pending && item.waitCode === MODE_DECLINED;
  const byMode = pending && item.approvalBy === "mode" && !declined;

  /** A press, its key the retry's too; the row stays busy once it is done, until the queue drops it. */
  async function decide(decision: Decision, final: Final = {}, key = crypto.randomUUID()) {
    if (running.current) return;
    running.current = true;
    setPressed(decision);
    setFailure(undefined);
    const header = { "Idempotency-Key": key };
    const params = { path: { workspaceId: workspace, id: item.id }, header };
    const retry = () => void decide(decision, final, key);
    let done = false;
    try {
      const api = browserApi();
      const { error, response } =
        decision === "approve"
          ? await api.POST("/v1/workspaces/{workspaceId}/approvals/items/{id}/approve", {
              params,
              body: { ...final, ...(draft && { draftId: draft.id }) },
            })
          : await api.POST("/v1/workspaces/{workspaceId}/approvals/items/{id}/skip", { params });
      if (response.ok) {
        done = true;
        onDecided(
          decision === "approve" ? t("toast.approved", { name }) : t("toast.skipped", { name }),
        );
        return;
      }
      const refusal = new ApiError(response.status, error);
      if (refusal.code !== REFUSED) return setFailure({ error: refusal, issues: [], retry });
      // The text stays as typed, else the draft's own opens in the field, to be changed.
      setFailure({ error: refusal, issues: issuesOf(error) });
      setTyped(final.text ?? draft?.text ?? "");
      if (final.subject !== undefined) setSubjectTyped(final.subject);
    } catch {
      setFailure({ error: new ApiError(500, undefined), issues: [], retry });
    } finally {
      if (!done) {
        running.current = false;
        setPressed(undefined);
      }
    }
  }

  return (
    <li className="min-w-0">
      <article
        aria-labelledby={nameId}
        className="grid min-w-0 gap-4 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5 [&_.wt-field]:min-w-0"
      >
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-0.5">
            <Heading id={nameId} className="font-semibold wrap-break-word text-ink">
              {lead ? <Link href={`/w/${workspace}/leads/${lead.personId}`}>{name}</Link> : name}
            </Heading>
            {role && <p className="text-sm wrap-break-word text-ink-muted">{role}</p>}
          </div>
          {isTier(tier) && <Badge tier={tier} />}
        </header>
        {why && (
          <p className="line-clamp-2 text-sm text-pretty text-ink-muted" title={why}>
            {why}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Action aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
            {words.step(item.stepKey, item.actionType)}
          </span>
          {item.channel === "email" && item.sender && (
            <span className="min-w-0 wrap-break-word text-ink-muted">
              {t("mailbox", { address: item.sender.label })}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-ink-muted">
            <Clock aria-hidden="true" className="size-4 shrink-0" />
            {t.rich("due", { at: at(item.scheduledFor), time: timed(item.scheduledFor) })}
          </span>
          {item.stale && (
            <Badge tone="warning">
              <History aria-hidden="true" />
              {t("flag.stale")}
            </Badge>
          )}
          {item.needsAttention && (
            <Badge tone="danger">
              <AlarmClock aria-hidden="true" />
              {t("flag.needs_attention")}
            </Badge>
          )}
          {drafting && <Badge tone="accent">{t("flag.drafting")}</Badge>}
          {failed && (
            <Badge tone="danger">
              <CircleX aria-hidden="true" />
              {t("flag.failed")}
            </Badge>
          )}
          {draft?.status === "flagged" && (
            <Badge tone="warning">
              <Flag aria-hidden="true" />
              {t("flag.gate_warning")}
            </Badge>
          )}
          {item.waitCode !== null && !declined && (
            <Badge>
              <Hourglass aria-hidden="true" />
              {t("flag.waiting", { reason: words.wait(item.waitCode) })}
            </Badge>
          )}
        </div>
        {byMode && (
          <div className={`${NOTE} bg-canvas ring-1 ring-line ring-inset`}>
            <p className="flex items-start gap-2 text-ink">
              <Bot aria-hidden="true" className={ICON} />
              {t("by_mode")}
            </p>
            {lines[item.channel]}
          </div>
        )}
        {declined && (
          <div className={`${NOTE} bg-canvas ring-1 ring-line ring-inset`}>
            <p className="flex items-start gap-2 text-ink">
              <Bot aria-hidden="true" className={ICON} />
              {words.declined(item)}
            </p>
          </div>
        )}
        {item.waitUntil !== null && (
          <p className="text-sm text-ink-muted">
            {t.rich("wait.until", { at: at(item.waitUntil), time: timed(item.waitUntil) })}
          </p>
        )}
        {flagged.length > 0 && (
          <ul className={`${NOTE} border border-warm-dot/30 bg-warm-soft text-warm-ink`}>
            {flagged.map((issue, index) => (
              <li key={index} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" className={ICON} />
                {words.gate(issue)}
              </li>
            ))}
          </ul>
        )}
        {drafting || draft === null ? (
          <p role="status" className="wt-loading-state text-sm">
            <span className="wt-spinner" aria-hidden="true" />
            {t("drafting")}
          </p>
        ) : editing !== undefined ? (
          <>
            {failed && <p className="text-sm text-ink-muted">{t("hint.failed")}</p>}
            {subject !== undefined && (
              <TextField
                label={t("subject")}
                value={subject}
                onChange={(event) => setSubjectTyped(event.target.value)}
                {...(subjectOff ? { error: subjectHint(subject) } : { hint: subjectHint(subject) })}
              />
            )}
            <TextArea
              label={t("text")}
              rows={5}
              value={editing}
              onChange={(event) => setTyped(event.target.value)}
              {...notes}
            />
          </>
        ) : failed ? null : (
          // A failed draft has no text to show: only its owner opens the field to write one.
          <div className="grid gap-2 rounded-xl bg-canvas p-3 ring-1 ring-line ring-inset sm:p-4">
            {draft.subject !== null && (
              <p className="wrap-break-word text-ink-muted">
                {t.rich("subject_shown", {
                  subject: draft.subject,
                  strong: (chunks) => <span className="font-medium text-ink">{chunks}</span>,
                })}
              </p>
            )}
            {draft.text ? (
              <p className="max-w-prose rounded-2xl rounded-es-md bg-surface px-4 py-3 leading-relaxed wrap-break-word whitespace-pre-wrap text-ink shadow-xs ring-1 ring-line">
                {draft.text}
              </p>
            ) : (
              <p className="text-ink-muted">{t("empty_note")}</p>
            )}
            <p className="text-xs text-ink-muted tabular-nums">{counter(draft.text ?? "")}</p>
          </div>
        )}
        {issues && issues.length > 0 && (
          <ul className={`${NOTE} bg-danger-soft text-danger-ink`}>
            {issues.map((issue, index) => (
              <li key={index} className="flex items-start gap-2">
                <CircleX aria-hidden="true" className={ICON} />
                {words.gate(issue)}
              </li>
            ))}
          </ul>
        )}
        {lead && draft && draft.factIds.length > 0 && (
          <Facts
            workspace={workspace}
            personId={lead.personId}
            factIds={draft.factIds}
            nested={nested}
          />
        )}
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            {!drafting && draft !== null && (
              <Button
                variant="primary"
                loading={pressed === "approve"}
                disabled={over || short || subjectOff}
                onClick={() => void decide("approve", finalOf(editing, subjectTyped))}
                {...decisions}
              >
                <Check aria-hidden="true" />
                {t("action.approve")}
              </Button>
            )}
            {!drafting && draft !== null && editing === undefined && (
              <Button
                onClick={() => {
                  setTyped(draft.text ?? "");
                  setSubjectTyped(undefined);
                }}
                {...decisions}
              >
                <PenLine aria-hidden="true" />
                {t("action.edit")}
              </Button>
            )}
            {typed !== undefined && !failed && (
              <Button
                onClick={() => {
                  setTyped(undefined);
                  setSubjectTyped(undefined);
                  setFailure(undefined);
                }}
              >
                {t("action.cancel")}
              </Button>
            )}
            <Button
              variant="ghost"
              loading={pressed === "skip"}
              onClick={() => setSkipping(true)}
              {...decisions}
            >
              <SkipForward aria-hidden="true" />
              {t("action.skip")}
            </Button>
          </div>
        )}
        {owner && <ErrorState module={owner.module} code={owner.code} onRetry={failure?.retry} />}
        <Dialog
          open={skipping}
          onClose={() => setSkipping(false)}
          title={t("skip.title")}
          actions={
            <Button
              variant="danger"
              onClick={() => {
                setSkipping(false);
                void decide("skip");
              }}
            >
              {t("skip.confirm")}
            </Button>
          }
        >
          <p className="my-3 text-pretty">
            {item.actionType === "invite"
              ? t("skip.body_connect", { name })
              : t("skip.body_message", { name })}
          </p>
        </Dialog>
      </article>
    </li>
  );
}
