const cx = (...names: (string | false)[]) => names.filter(Boolean).join(" ");

export function Page({ wide }: { wide: boolean }) {
  return (
    <div className="ml-2 pr-4 hover:left-0 text-right">
      <p className={cx("border-l", wide && "md:rounded-r-lg")} />
      <span className={`-mr-1 ${wide ? "rounded-tl-md" : "float-left"}`} />
    </div>
  );
}
