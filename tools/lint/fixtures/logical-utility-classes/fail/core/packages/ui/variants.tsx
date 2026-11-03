// Class strings held in consts: read where a className or a cx() names them, directly, through a
// member access, or through a const destructured from one.
const cx = (...names: (string | false)[]) => names.filter(Boolean).join(" ");
const VARIANTS = { quiet: "pl-3 text-ink-muted", loud: "ps-3 font-semibold" };
const SHIMMER = "rounded-r-full bg-muted";
const TIERS = { hot: ["text-left", "ms-1"] } as const;

export function Variant({ variant }: { variant: keyof typeof VARIANTS }) {
  const [badge] = TIERS.hot;
  return (
    <p className={VARIANTS[variant]}>
      <span className={cx(SHIMMER, "h-3")} />
      <span className={badge} />
    </p>
  );
}
