import type { ReactNode } from "react";

type PageHeaderProps = {
  title: string;
  /** A sentence under the title that says what the screen is for. */
  description?: string;
  /** Before the title: what the screen is about, an `Avatar` say, decorative. */
  leading?: ReactNode;
  /** Under the title and the sentence: a row of facts, badges say. */
  meta?: ReactNode;
  actions?: ReactNode;
};

/** The top of a screen: its one `h1` and a sentence under it, then the screen's actions at the inline end. */
export function PageHeader({ title, description, leading, meta, actions }: PageHeaderProps) {
  return (
    <header className="wt-page-header flex w-full flex-wrap items-end gap-x-4 gap-y-3 pb-6">
      <div className="flex min-w-0 grow basis-72 items-start gap-4">
        {leading}
        {/* One column of minmax(0, 1fr): a wide meta row scrolls or wraps inside it, never widens it. */}
        <div className="grid min-w-0 grid-cols-1 gap-1">
          {/* A title without spaces, a LinkedIn URL say, breaks inside rather than widen the page. */}
          <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink wrap-break-word">
            {title}
          </h1>
          {description ? (
            <p className="max-w-3xl text-pretty text-ink-muted">{description}</p>
          ) : null}
          {meta ? <div className="mt-1.5 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
