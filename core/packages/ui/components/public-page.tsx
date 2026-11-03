import type { ReactNode } from "react";
import { useTranslations } from "../translations.tsx";
import { TIDE_BOX, TIDE_CREST, TIDE_SWELLS } from "./brand.ts";
import { cx } from "./cx.ts";
import { Logo } from "./logo.tsx";

type PublicPageProps = {
  title: string;
  description?: string;
  /** An icon over the title, on the accent's tint: an element, `<MailCheck aria-hidden="true" />`. */
  icon?: ReactNode;
  /** The brand's panel at the inline end, from 1024 px wide: the sign-in pages have it. */
  panel?: boolean;
  children?: ReactNode;
};

/**
 * A page outside the workspaces (sign-in, not found): the logo, then the page's one `h1`, its
 * sentence and its content, centred in the page's `main`; with `panel`, the brand's panel beside it.
 */
export function PublicPage({ title, description, icon, panel, children }: PublicPageProps) {
  return (
    <div
      className={cx(
        "relative isolate grid min-h-dvh overflow-hidden",
        panel ? "bg-surface lg:grid-cols-2" : "bg-canvas",
      )}
    >
      <Tide className={cx("h-1/4 text-accent", panel && "lg:hidden")} />
      <main className="flex flex-col gap-10 px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto my-auto grid w-full max-w-sm animate-rise gap-6 pb-12">
          {icon ? (
            <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-ink shadow-xs ring-1 ring-accent/15 ring-inset [&_svg]:size-5">
              {icon}
            </span>
          ) : null}
          <div className="grid gap-2">
            <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            {description ? (
              <p className="text-pretty text-[0.9375rem] text-ink-muted">{description}</p>
            ) : null}
          </div>
          {children}
        </div>
      </main>
      {panel ? <BrandPanel /> : null}
    </div>
  );
}

/** The brand's panel, dark in both themes: the tide, a signal over it, and what Whytide does. */
function BrandPanel() {
  const t = useTranslations("ui.brand");
  return (
    <aside
      data-theme="dark"
      className="relative isolate m-3 hidden flex-col justify-center overflow-hidden rounded-3xl bg-canvas p-12 text-ink ring-1 ring-line lg:flex"
    >
      <div aria-hidden="true" className="tide-glow absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className="absolute end-16 top-16 grid place-items-center *:col-start-1 *:row-start-1"
      >
        <span className="size-56 rounded-full border border-tide-start/10" />
        <span className="size-36 rounded-full border border-tide-start/20" />
        <span className="size-16 rounded-full border border-tide-start/35" />
        <span className="size-2.5 rounded-full bg-tide-start shadow-[0_0_20px_6px] shadow-tide-start/50" />
      </div>
      <Tide className="h-1/3 text-tide-start" />
      <div className="grid max-w-md gap-4">
        <p className="text-balance text-3xl font-semibold tracking-tight">{t("tagline")}</p>
        <p className="text-pretty text-base text-ink-muted">{t("pitch")}</p>
      </div>
    </aside>
  );
}

function Tide({ className }: { className: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox={TIDE_BOX}
      preserveAspectRatio="none"
      className={cx("pointer-events-none absolute inset-x-0 bottom-0 -z-10 w-full", className)}
    >
      {TIDE_SWELLS.map(({ d, opacity }) => (
        <path key={d} d={d} fill="currentColor" opacity={opacity} />
      ))}
      <path
        d={TIDE_CREST}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
