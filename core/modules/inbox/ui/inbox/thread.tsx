// A thread in the browser (thread-page.tsx gives it the first read): the way back to the inbox; the
// lead's name, linked to their lead page, with their title and company; the messages, oldest first,
// each with its time and its author in words: the person; the campaign, approved at a time; or the
// account's owner, who typed it on LinkedIn or replied from here, the reply's state then
// (reply-status.tsx); on each reply its label (label-buttons.tsx, gamma-p4-055): the owner's, else
// the classifier's, "Suggested" beside it until the owner confirms or changes it, which only the
// thread's owner does (the read's `reply.own`). Under them the reply box (reply-box.tsx), on the
// caller's own thread whose channel sends now only (the read's `reply`: `own`, `channelAvailable`):
// the caller's own thread without it, a line saying why; another member's, a line that only its
// owner replies. While a reply is sending, the thread is read again every SENDING_POLL_MS,
// SENDING_POLL_MAX times at most. The states: a thread without a message; a failed read in words,
// its module's (src/api/errors.ts errorOwner), with Try again, which reads the thread again (GET
// …/inbox/threads/{id}).
"use client";

import { ButtonLink, EmptyState, ErrorState, Link, PageHeader } from "@whytide/ui";
import { ArrowLeft, Info } from "@whytide/ui/icons";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useFormatter, useMessages, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { MessageResponse, ThreadResponse } from "../../schemas/threads.ts";
import { SENDING_POLL_MAX, SENDING_POLL_MS, TIME_FORMAT } from "./constants.ts";
import { LabelControl } from "./label-buttons.tsx";
import { usePersonWords } from "./person.ts";
import { ReplyBox } from "./reply-box.tsx";
import { ReplyStatus } from "./reply-status.tsx";

/** The first read's answer, or the digest of its refusal (`api:<code>`, src/api/errors.ts). */
type Props = { workspace: string; threadId: string } & (
  | { first: ThreadResponse }
  | { failed: string }
);

const CARD = "grid min-w-0 gap-2.5 rounded-xl border border-line p-4 shadow-xs";
/** A reply on the surface, nearer the inline start; the account's messages muted, nearer the end. */
const SIDE = { in: `${CARD} bg-surface sm:me-12`, out: `${CARD} bg-muted sm:ms-12` } as const;

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

/** The way back to the list, above the thread in each of its states. */
export function BackLink({ workspace }: { workspace: string }) {
  const t = useTranslations("inbox.thread");
  return (
    <nav aria-label={t("navigation")} className="-mt-2 mb-5 flex min-h-8 items-center">
      <div className="-ms-2.5">
        <ButtonLink href={`/w/${workspace}/inbox`} variant="ghost" size="sm">
          <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
          {t("back")}
        </ButtonLink>
      </div>
    </nav>
  );
}

export function Thread(props: Props) {
  const { workspace, threadId } = props;
  const t = useTranslations("inbox.thread");
  const errors = useTranslations("inbox.errors");
  const messages = useMessages();
  const person = usePersonWords();
  const id = useId();
  const [thread, setThread] = useState("first" in props ? props.first : undefined);
  const [failure, setFailure] = useState("failed" in props ? props.failed : undefined);
  const polls = useRef(0);

  const load = useCallback(async () => {
    try {
      const params = { path: { workspaceId: workspace, id: threadId } };
      const read = browserApi().GET("/v1/workspaces/{workspaceId}/inbox/threads/{id}", { params });
      setThread(await data(read));
      setFailure(undefined);
    } catch (error) {
      setFailure(digestOf(error));
    }
  }, [workspace, threadId]);

  // Each read sets a new thread, so the next wait starts while a reply is still sending.
  useEffect(() => {
    const sending = thread?.messages.some((message) => message.sendStatus === "sending");
    if (!sending || polls.current >= SENDING_POLL_MAX) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load();
    }, SENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [thread, load]);

  async function sent() {
    polls.current = 0;
    await load();
  }

  if (thread === undefined) {
    const owner = errorOwner({ digest: failure }, messages);
    return (
      <>
        <BackLink workspace={workspace} />
        <PageHeader title={t("title")} />
        <section aria-labelledby={`${id}-error`} className="grid max-w-3xl gap-3">
          <h2 id={`${id}-error`} className="font-semibold text-ink">
            {t("error")}
          </h2>
          <ErrorState module={owner.module} code={owner.code} onRetry={() => void load()} />
        </section>
      </>
    );
  }

  const name = person.name(thread.person);
  const role = person.role(thread.person);
  return (
    <>
      <BackLink workspace={workspace} />
      {/* The ui's PageHeader takes its title as text: here the name is a link to the lead page. */}
      <header className="grid min-w-0 gap-1 pb-6">
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink wrap-break-word">
          {thread.person === null ? (
            name
          ) : (
            <Link href={`/w/${workspace}/leads/${thread.personId}`}>{name}</Link>
          )}
        </h1>
        {role && <p className="max-w-3xl text-pretty text-ink-muted">{role}</p>}
      </header>
      {thread.messages.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <ol aria-label={t("messages")} className="grid max-w-3xl gap-3">
          {thread.messages.map((message) => (
            <Message
              key={message.id}
              workspace={workspace}
              message={message}
              lead={name}
              own={thread.reply.own}
            />
          ))}
        </ol>
      )}
      {thread.reply.own && thread.reply.channelAvailable ? (
        <ReplyBox workspace={workspace} threadId={threadId} reply={thread.reply} onSent={sent} />
      ) : (
        <p className="mt-6 flex max-w-3xl items-start gap-2 text-pretty text-ink-muted">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {thread.reply.own ? errors("reply_channel_unavailable") : t("owner_only")}
        </p>
      )}
    </>
  );
}

/**
 * One message: who wrote it, in words, and when; a reply from here, its state; its text; a reply's
 * label, which the thread's owner (`own`) confirms or changes.
 */
function Message(props: {
  workspace: string;
  message: MessageResponse;
  lead: string;
  own: boolean;
}) {
  const { workspace, message, lead, own } = props;
  const t = useTranslations("inbox.thread");
  const format = useFormatter();
  const id = useId();
  const at = (time: string) => format.dateTime(new Date(time), TIME_FORMAT);
  const timed = (time: string) => (chunks: ReactNode) => <time dateTime={time}>{chunks}</time>;
  const { direction, sentBy, approvedAt, sentAt, sendStatus } = message;
  let author = lead;
  let how: ReactNode = null;
  if (direction === "out" && sentBy === "campaign") {
    author = t("author.campaign");
    if (approvedAt !== null)
      how = t.rich("approved", { at: at(approvedAt), time: timed(approvedAt) });
  } else if (direction === "out") {
    author = t("author.user");
    if (sendStatus === null) how = t("typed");
  }
  return (
    <li className="min-w-0">
      <article aria-labelledby={`${id}-author`} className={SIDE[direction]}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p id={`${id}-author`} className="font-semibold text-ink">
            {author}
          </p>
          <time dateTime={sentAt} className="text-xs text-ink-muted tabular-nums">
            {at(sentAt)}
          </time>
        </div>
        {how && <p className="text-xs text-ink-muted">{how}</p>}
        {sendStatus !== null && <ReplyStatus status={sendStatus} code={message.errorCode} />}
        <p className="whitespace-pre-wrap text-pretty wrap-break-word text-ink">{message.body}</p>
        {direction === "in" && (
          <LabelControl
            workspace={workspace}
            messageId={message.id}
            label={message.label}
            classification={message.classification}
            own={own}
          />
        )}
      </article>
    </li>
  );
}
