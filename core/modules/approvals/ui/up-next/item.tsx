// One row of "Up next" (queue.tsx): the lead, their name linked to the lead page, title, company,
// tier and first why bullet, as the lead list shows them; the step's action and when it is due, in
// its sender's zone; the flags, stale, needs attention, drafting, draft failed, gate warning with the
// draft's issues, and waiting with its reason; the text with its counter against the draft's
// maxCharacters, or a spinner while it is being written; the facts it uses (facts.tsx); then Edit,
// Approve and Skip. Edit opens the text in a field held to the draft's limits, whose Approve sends
// what was typed; a failed draft opens it empty. A refused text shows each gate's issue and keeps
// what was typed. Skip asks first, and says that skipping a connection request ends the sequence.
// Approve and Skip send an Idempotency-Key per press, which Try again sends again. A member who does
// not own the sender account sees the row with its decisions disabled, and why.
"use client";

import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Link,
  TextArea,
  type Tier,
  useKeyText,
} from "@whytide/ui";
import {
  AlarmClock,
  Check,
  CircleX,
  Clock,
  Flag,
  History,
  Hourglass,
  type LucideIcon,
  MessageSquare,
  PenLine,
  SkipForward,
  TriangleAlert,
  UserPlus,
} from "@whytide/ui/icons";
import { ApiError, browserApi, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { type ReactNode, useId, useRef, useState } from "react";
import { FALLBACK_TIME_ZONE } from "../../domain/items/constants.ts";
import type { ItemResponse } from "../../schemas/items.ts";
import { TIME_FORMAT } from "./constants.ts";
import { Facts } from "./facts.tsx";
import { type GateIssue, useUpNextWords } from "./words.ts";

type Props = {
  workspace: string;
  item: ItemResponse;
  /** The decision done, in the toast's words: the queue reads itself again. */
  onDecided: (message: string) => void;
};
type Decision = "approve" | "skip";
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
/** Each action's icon, beside its words: a connection request, or a message. */
const ACTION_ICON: Record<ItemResponse["actionType"], LucideIcon> = {
  invite: UserPlus,
  message: MessageSquare,
};
const REFUSED = "draft_text_refused";
const NOTE = "grid gap-1.5 rounded-lg px-3 py-2.5 text-sm";
const ICON = "mt-0.5 size-4 shrink-0";

/** A text's length as the api counts it: UTF-16 units, as a textarea counts them, trimmed. */
const lengthOf = (text: string) => text.trim().length;
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

export function Item({ workspace, item, onDecided }: Props) {
  const t = useTranslations("approvals.up_next");
  const words = useUpNextWords();
  const keyText = useKeyText();
  const messages = useMessages();
  const format = useFormatter();
  const ids = { name: useId(), hint: useId() };
  const { draft, lead } = item;
  const pending = item.status === "pending";
  const drafting = isDrafting(item);
  const failed = draft?.status === "failed";
  const [typed, setTyped] = useState<string>();
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
  const decisions = item.canDecide ? {} : { disabled: true, "aria-describedby": ids.hint };

  /** A press, its key the retry's too; the row stays busy once it is done, until the queue drops it. */
  async function decide(decision: Decision, text?: string, key = crypto.randomUUID()) {
    if (running.current) return;
    running.current = true;
    setPressed(decision);
    setFailure(undefined);
    const header = { "Idempotency-Key": key };
    const params = { path: { workspaceId: workspace, id: item.id }, header };
    const retry = () => void decide(decision, text, key);
    let done = false;
    try {
      const api = browserApi();
      const { error, response } =
        decision === "approve"
          ? await api.POST("/v1/workspaces/{workspaceId}/approvals/items/{id}/approve", {
              params,
              body: text === undefined ? {} : { text },
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
      setTyped(text ?? draft?.text ?? "");
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
        aria-labelledby={ids.name}
        className="grid min-w-0 gap-4 rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5 [&_.wt-field]:min-w-0"
      >
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid min-w-0 gap-0.5">
            <h3 id={ids.name} className="font-semibold wrap-break-word text-ink">
              {lead ? <Link href={`/w/${workspace}/leads/${lead.personId}`}>{name}</Link> : name}
            </h3>
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
          {item.waitCode !== null && (
            <Badge>
              <Hourglass aria-hidden="true" />
              {t("flag.waiting", { reason: words.wait(item.waitCode) })}
            </Badge>
          )}
        </div>
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
          <Facts workspace={workspace} personId={lead.personId} factIds={draft.factIds} />
        )}
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            {!drafting && draft !== null && (
              <Button
                variant="primary"
                loading={pressed === "approve"}
                disabled={over || short}
                onClick={() => void decide("approve", editing)}
                {...decisions}
              >
                <Check aria-hidden="true" />
                {t("action.approve")}
              </Button>
            )}
            {!drafting && draft !== null && editing === undefined && (
              <Button onClick={() => setTyped(draft.text ?? "")} {...decisions}>
                <PenLine aria-hidden="true" />
                {t("action.edit")}
              </Button>
            )}
            {typed !== undefined && !failed && (
              <Button
                onClick={() => {
                  setTyped(undefined);
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
        {pending && !item.canDecide && (
          <p id={ids.hint} className="text-sm text-ink-muted">
            {t("hint.not_owner")}
          </p>
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
