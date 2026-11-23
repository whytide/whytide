import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { useTranslations } from "../translations.tsx";
import { Button } from "./button.tsx";

const CONTROLS = "a[href], button, input, select, textarea, [tabindex]";

/** A control Tab stops at: in the tab order, enabled (a disabled fieldset's too), and shown. */
function reachable(control: HTMLElement): boolean {
  return (
    control.tabIndex >= 0 &&
    !control.matches(":disabled") &&
    control.checkVisibility({ visibilityProperty: true })
  );
}

/** Tab past the last control comes back to the first, and Shift+Tab the other way round. */
function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const all = event.currentTarget.querySelectorAll<HTMLElement>(CONTROLS);
  const controls = [...all].filter(reachable);
  const at = controls.findIndex((control) => control === document.activeElement);
  if (event.shiftKey ? at <= 0 : at === controls.length - 1) {
    event.preventDefault();
    controls.at(event.shiftKey ? -1 : 0)?.focus();
  }
}

/**
 * Holds the page behind still: the document's overflow hidden, until the function returned puts
 * back the value it found.
 */
function lockScroll(): () => void {
  const root = document.documentElement.style;
  const found = root.overflow;
  root.overflow = "hidden";
  return () => {
    root.overflow = found;
  };
}

/** Undoes what opening did, once: the scroll lock, then the focus on the opener. */
function settle(undo: RefObject<(() => void) | null>) {
  const steps = undo.current;
  undo.current = null;
  steps?.();
}

export type DialogProps = {
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
 * A modal on the native `<dialog>`: the page behind it is inert and holds still, and Tab cycles
 * through its controls, so the focus stays inside; Escape closes it. The first control takes the
 * focus: Cancel, before the actions, when the body has none. However it closes (Escape, Cancel, the
 * module's action, or the module unmounting it while open), the page scrolls again and the focus
 * returns to the control that opened it.
 */
export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const t = useTranslations("ui.action");
  const ref = useRef<HTMLDialogElement>(null);
  // What closing undoes, set on opening while the dialog is open.
  const undo = useRef<(() => void) | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open === open) return;
    if (open) {
      const opener = document.activeElement;
      const unlock = lockScroll();
      undo.current = () => {
        unlock();
        if (opener instanceof HTMLElement) opener.focus();
      };
      dialog.showModal();
    } else {
      dialog.close();
      settle(undo);
    }
  }, [open]);
  // Unmounted while open, a dialog fires no `close`: the page and the focus come back all the same.
  // A node still in the document is StrictMode rehearsing an unmount, and the dialog stays open.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (!dialog?.isConnected) settle(undo);
    };
  }, []);
  // `close` fires however it closed. On Escape `open` is still true here: the module hears of it.
  // A dialog open again by the time it fires is not closed.
  const closed = () => {
    if (ref.current?.open) return;
    settle(undo);
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
