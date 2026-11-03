const cx = (...names: (string | false)[]) => names.filter(Boolean).join(" ");
const side = "left"; // a string outside a className is not a class
const TONES = { quiet: "ms-1 text-ink-muted", loud: "pe-2 font-semibold" };
// Consts a class never reads: a value elsewhere, a method's object.
const PLACE = "left-0";
const NAMES = new Set(["pl-x"]);

export function Panel({ wide, name }: { wide: boolean; name: string }) {
  return (
    <div
      data-side={side}
      className={cx(
        "ms-2 me-auto ps-4 pe-2 -ms-1 start-0 end-4 text-start text-end border-s border-e-2",
        "rounded-s-lg rounded-ee float-start clear-end mt-2 pb-4 top-0 border-b",
        wide && "lg:pe-8 [&:has(+:popover-open)]:bg-hover [&_svg]:size-4 hover:!ms-0",
      )}
    >
      <span className={`inset-x-0 mx-auto px-3 ${side}`} />
      <span data-place={PLACE} className={NAMES.has(name) ? TONES.loud : TONES.quiet} />
    </div>
  );
}
