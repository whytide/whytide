import { useTranslations } from "../translations.tsx";
import { MARK_BOX, MARK_SIGNAL, MARK_WAVES } from "./brand.ts";
import { cx } from "./cx.ts";

const SIZES = {
  sm: "size-6 rounded-md",
  md: "size-8 rounded-[0.625rem]",
  lg: "size-12 rounded-2xl",
};

/** The mark: two waves of the tide and the signal over them, on the brand's gradient. Decorative. */
export function LogoMark({ size = "md" }: { size?: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid shrink-0 place-items-center bg-linear-135 from-tide-start via-tide-mid to-tide-end text-white shadow-sm ring-1 ring-white/20 ring-inset",
        SIZES[size],
      )}
    >
      <svg viewBox={MARK_BOX} fill="none" className="size-[72%]">
        <circle {...MARK_SIGNAL} fill="currentColor" />
        {MARK_WAVES.map((wave, index) => (
          <path
            key={wave}
            d={wave}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            opacity={index === 0 ? 1 : 0.55}
          />
        ))}
      </svg>
    </span>
  );
}

/** The mark and the name, the brand's lockup. */
export function Logo() {
  const t = useTranslations("ui.brand");
  return (
    <span className="inline-flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-tight text-ink">
      <LogoMark />
      {t("name")}
    </span>
  );
}
