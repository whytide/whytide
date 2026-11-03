import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { useTranslations } from "../translations.tsx";
import { Button } from "./button.tsx";

const CONTROLS =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Tab past the last control comes back to the first, and Shift+Tab the other way round. */
function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(CONTROLS)];
  const at = controls.findIndex((control) => control === document.activeElement);
  if (event.shiftKey ? at <= 0 : at === controls.length - 1) {
    event.preventDefault();
    controls.at(event.shiftKey ? -1 : 0)?.focus();
  }
}

type DialogProps = {
  /** Shown, as a modal, while true: the module holds the state. */
  open: boolean;
  /** The person closed it, by Escape or Cancel: the module sets `open` to false. */
  onClose: () => void;
  /** The heading that names the dialog: text the module translated. */
  title: string;
  children?: ReactNode;
  /** The buttons after Cancel: the confirmation, say. */
  actions?: ReactNode;
};

/**
 * A modal on the native `<dialog>`: the page behind it is inert and Tab cycles through its controls,
 * so the focus stays inside; Escape closes it; the focus returns to the control that opened it.
 * The first control takes the focus: Cancel, before the actions, when the body has none.
 */
export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const t = useTranslations("ui.action");
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open === open) return;
    if (open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [open]);
  // `close` fires however it closed: Escape (while `open` is still true here), or `open` set false.
  const closed = () => {
    if (opener.current instanceof HTMLElement) opener.current.focus();
    if (open) onClose();
  };
  return (
    <dialog
      ref={ref}
      className="wt-dialog m-auto w-[min(30rem,100%-2rem)] max-w-none overflow-hidden rounded-2xl border border-line bg-raised text-ink shadow-lg open:animate-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:backdrop:animate-fade dark:backdrop:bg-black/60"
      aria-labelledby={titleId}
      onClose={closed}
      onKeyDown={keepFocus}
    >
      <div className="grid gap-2 p-6 text-ink-muted">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {children}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-muted/60 px-6 py-4">
        <Button onClick={onClose}>{t("cancel")}</Button>
        {actions}
      </div>
    </dialog>
  );
}
