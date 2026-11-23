// A reply from the inbox on its message (thread.tsx; README.md "Replies from the inbox"): Sending
// until it settles, Sent, or Not sent with its reason in words, never its code. A reply refused is
// not kept for later: outside the account's working hours, at the weekend or past the day's limits,
// the member sends it again, so those codes, whose module's words say a send waits, have a reply's
// own words (REPLY_REASONS, constants.ts), as do contacts' person_suppressed and the channel gone;
// any other code shows inbox's words, else linkedin's (sending closed, a stop or a pause), else the
// words for any other. One live region for the reply's life, so a change the thread's next read
// brings is announced.
"use client";

import { useKeyText } from "@whytide/ui";
import { CircleAlert, CircleCheck, Clock } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import type { MessageResponse } from "../../schemas/threads.ts";
import { REPLY_REASONS, type ReplyReason } from "./constants.ts";

type Props = { status: NonNullable<MessageResponse["sendStatus"]>; code: string | null };

const LINE = "flex items-center gap-1.5 text-xs";
const ICON = "size-3.5 shrink-0";

/** A Not sent reply's reason in words, by its code; null, or a code no words know, the generic. */
function useReason(): (code: string | null) => string {
  const t = useTranslations("inbox");
  const text = useKeyText();
  const words: Record<ReplyReason, string> = {
    suppressed: t("errors.person_suppressed"),
    unavailable: t("errors.reply_channel_unavailable"),
    hours: t("reply.reason.outside_working_hours"),
    day_used: t("reply.reason.day_used"),
    refused: t("reply.reason.refused_by_linkedin"),
    other: t("reply.reason.other"),
  };
  return (code) => {
    if (code === null) return words.other;
    // Never a member every object inherits, such as `constructor`.
    if (Object.hasOwn(REPLY_REASONS, code)) return words[REPLY_REASONS[code] ?? "other"];
    return text(`inbox.errors.${code}`) ?? text(`linkedin.errors.${code}`) ?? words.other;
  };
}

export function ReplyStatus({ status, code }: Props) {
  const t = useTranslations("inbox");
  const reason = useReason();
  return (
    <div role="status" className="grid gap-0.5">
      {status === "sending" && (
        <p className={`${LINE} text-ink-muted`}>
          <Clock aria-hidden="true" className={ICON} />
          {t("reply.status.sending")}
        </p>
      )}
      {status === "sent" && (
        <p className={`${LINE} text-ink-muted`}>
          <CircleCheck aria-hidden="true" className={ICON} />
          {t("reply.status.sent")}
        </p>
      )}
      {(status === "refused" || status === "failed") && (
        <>
          <p className={`${LINE} font-semibold text-danger-ink`}>
            <CircleAlert aria-hidden="true" className={ICON} />
            {t("reply.status.not_sent")}
          </p>
          <p className="text-pretty text-xs text-ink-muted">{reason(code)}</p>
        </>
      )}
    </div>
  );
}
