// The navigation on a narrow screen (docs/screens.md "The shell"): a button in the header that opens
// the sidebar's content as a modal drawer at the inline start. Escape, a click outside or a link
// followed closes it, and the focus returns to the button.
"use client";

import { Button } from "@whytide/ui";
import { PanelLeft, X } from "@whytide/ui/icons";
import { type ReactNode, useRef } from "react";

type Props = { label: string; open: string; close: string; children: ReactNode };

export function Drawer({ label, open, close, children }: Props) {
  const drawer = useRef<HTMLDialogElement>(null);
  return (
    <div className="lg:hidden">
      <Button
        variant="ghost"
        size="sm"
        aria-label={open}
        onClick={() => drawer.current?.showModal()}
      >
        <PanelLeft aria-hidden="true" className="rtl:-scale-x-100" />
      </Button>
      <dialog
        ref={drawer}
        aria-label={label}
        className="m-0 h-dvh max-h-none w-72 max-w-[85vw] bg-canvas text-ink shadow-lg open:animate-drawer backdrop:bg-black/40 backdrop:backdrop-blur-[2px] open:backdrop:animate-fade rtl:open:animate-drawer-rtl dark:backdrop:bg-black/60"
        onClick={(event) => {
          const target = event.target as Element;
          if (target === event.currentTarget || target.closest("a")) event.currentTarget.close();
        }}
      >
        <div className="flex min-h-full flex-col gap-5 p-3">
          <div className="absolute end-3 top-3.5">
            <Button
              variant="ghost"
              size="sm"
              aria-label={close}
              onClick={() => drawer.current?.close()}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          {children}
        </div>
      </dialog>
    </div>
  );
}
