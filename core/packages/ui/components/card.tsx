import { type ReactNode, useId } from "react";

type CardProps = {
  /** Its heading, which names the card as a region: an `h2`, or an `h3` with `level={3}`. */
  title?: string;
  level?: 2 | 3;
  description?: string;
  /** Controls at the inline end of the heading. */
  actions?: ReactNode;
  children?: ReactNode;
};

/** One subject on a surface of its own: a fine border, a soft shadow, its heading on top. */
export function Card({ title, level = 2, description, actions, children }: CardProps) {
  const id = useId();
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className="wt-card grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      {title ? (
        <header className="flex items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <Heading id={id} className="font-semibold text-ink">
              {title}
            </Heading>
            {description ? <p className="text-pretty text-ink-muted">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}
