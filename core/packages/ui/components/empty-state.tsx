import { Waves } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "../translations.tsx";

/** A list or a screen with nothing in it, under the tide's mark: the module's sentence, or the shared one, and an action. */
export function EmptyState({ message, action }: { message?: string; action?: ReactNode }) {
  const t = useTranslations("ui.state");
  return (
    <div className="wt-empty-state flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line-strong/50 bg-surface px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent/15"
      >
        <Waves className="size-5" />
      </span>
      <p className="max-w-sm text-pretty text-ink-muted">{message ?? t("empty")}</p>
      {/* The action, or a paragraph of links: each its own item, spaced. */}
      {action ? (
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 *:flex *:flex-wrap *:justify-center *:gap-x-4 *:gap-y-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
