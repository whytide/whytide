// A reply's label (thread.tsx; gamma-p4-055): one control per reply. It shows the label shown, its
// badge: the thread owner's once chosen, else the classifier's with "Suggested" beside it until the
// owner chooses. On the caller's own thread, Confirm takes the suggestion in one click, and "Change
// label" opens a menu of the 7 labels (inbox.class.*), the chosen one pressed. A choice sends PUT
// …/inbox/messages/{id}/label with the label and shows the answer's; the chosen one again sends
// nothing. Choosing opt_out asks first, since an opt-out is never lifted; once the label moves away
// from an opt-out, the owner's or the classifier's, a line says the person stays suppressed. A
// refusal shows its code in words, its module's (src/api/errors.ts errorOwner), with Try again, which
// sends the choice again. On another member's thread the label shows, and nothing to choose: only the
// thread's owner labels its replies (the route answers anyone else 404).
"use client";

import { Badge, Button, Dialog, ErrorState, Menu, MenuItem } from "@whytide/ui";
import { Check, Info, Tag } from "@whytide/ui/icons";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { MessageResponse } from "../../schemas/threads.ts";
import {
  CLASS_LABELS,
  CLASS_TONES,
  type ClassLabel,
  LABEL_PATH,
  OPT_OUT_CLASS,
} from "./constants.ts";

type Props = {
  workspace: string;
  messageId: string;
  label: MessageResponse["label"];
  classification: MessageResponse["classification"];
  /** The caller's own thread: only its owner labels its replies. */
  own: boolean;
};
/** A choice that failed: its digest, and the label it asked for. */
type Failure = { readonly digest: string; readonly value: ClassLabel };

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

/** The 7 labels in words, each key written out for messages:check. */
function useClassWords(): Record<ClassLabel, string> {
  const t = useTranslations("inbox.class");
  return {
    interested: t("interested"),
    not_now: t("not_now"),
    not_interested: t("not_interested"),
    out_of_office: t("out_of_office"),
    opt_out: t("opt_out"),
    bounce: t("bounce"),
    other: t("other"),
  };
}

export function LabelControl({ workspace, messageId, label, classification, own }: Props) {
  const t = useTranslations("inbox.label");
  const classes = useTranslations("inbox.class");
  const words = useClassWords();
  const messages = useMessages();
  const [chosen, setChosen] = useState<ClassLabel | null>(label?.classLabel ?? null);
  const [pending, setPending] = useState<ClassLabel>();
  const [failure, setFailure] = useState<Failure>();
  const [asking, setAsking] = useState(false);
  // This view moved the label away from an opt-out.
  const [left, setLeft] = useState(false);
  const running = useRef(false);
  const items = useRef<HTMLDivElement>(null);
  const shown = chosen ?? classification?.label ?? null;
  const suggested = chosen === null && classification?.isSuggested === true;
  // The classifier's opt-out suppressed the person whatever the label says now (README.md "The label").
  const stays = shown !== OPT_OUT_CLASS && (left || classification?.label === OPT_OUT_CLASS);

  async function send(value: ClassLabel) {
    if (running.current) return;
    running.current = true;
    setPending(value);
    setFailure(undefined);
    const away = shown === OPT_OUT_CLASS && value !== OPT_OUT_CLASS;
    try {
      const answer = await data(
        browserApi().PUT(LABEL_PATH, {
          params: { path: { workspaceId: workspace, id: messageId } },
          body: { label: value },
        }),
      );
      setChosen(answer.classLabel);
      if (away) setLeft(true);
    } catch (error) {
      setFailure({ digest: digestOf(error), value });
    } finally {
      running.current = false;
      setPending(undefined);
    }
  }

  /** Confirm, or a row of the menu: the menu closes; opt_out asks first; the chosen one, nothing. */
  function pick(value: ClassLabel) {
    const panel = items.current?.closest<HTMLElement>("[popover]");
    if (panel?.matches(":popover-open")) panel.hidePopover();
    if (running.current || value === chosen) return;
    if (value === OPT_OUT_CLASS) setAsking(true);
    else void send(value);
  }

  const owner = failure && errorOwner({ digest: failure.digest }, messages);
  return (
    <div className="grid justify-items-start gap-2">
      <div role="group" aria-label={t("group")} className="flex flex-wrap items-center gap-2">
        {shown !== null && <Badge tone={CLASS_TONES[shown]}>{words[shown]}</Badge>}
        {suggested && <Badge>{classes("suggested")}</Badge>}
        {own && suggested && shown !== null && (
          <Button size="sm" loading={pending === shown} onClick={() => pick(shown)}>
            <Check aria-hidden="true" />
            {t("confirm")}
          </Button>
        )}
        {own && (
          <Menu
            trigger={
              <>
                <Tag aria-hidden="true" className="size-4 shrink-0" />
                {t("change")}
              </>
            }
          >
            <div ref={items}>
              {CLASS_LABELS.map((value) => (
                <MenuItem
                  key={value}
                  aria-pressed={value === chosen}
                  disabled={pending !== undefined}
                  onClick={() => pick(value)}
                >
                  {value === chosen ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <span aria-hidden="true" className="size-4 shrink-0" />
                  )}
                  {words[value]}
                </MenuItem>
              ))}
            </div>
          </Menu>
        )}
      </div>
      {stays && (
        <p className="flex items-start gap-2 text-pretty text-sm text-ink-muted">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("opt_out_stays")}
        </p>
      )}
      {owner && failure && (
        <ErrorState
          module={owner.module}
          code={owner.code}
          onRetry={() => void send(failure.value)}
        />
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title={words.opt_out}
        actions={
          <Button
            variant="danger"
            onClick={() => {
              setAsking(false);
              void send(OPT_OUT_CLASS);
            }}
          >
            {t("confirm")}
          </Button>
        }
      >
        <p className="my-3">{t("opt_out_confirm")}</p>
      </Dialog>
    </div>
  );
}
