/** A key to press, named in the text around it: Esc, Enter. */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-b-2 border-line bg-surface px-1 font-sans text-2xs font-medium text-ink-muted">
      {children}
    </kbd>
  );
}
