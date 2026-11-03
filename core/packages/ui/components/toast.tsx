/**
 * A short message in a polite live region at the bottom of the inline end. The region is always
 * rendered, empty without a message, so a screen reader announces the message when it arrives; the
 * owner sets `message` and clears it.
 */
export function Toast({ message }: { message?: string }) {
  return (
    <div role="status" className="wt-toast pointer-events-none fixed bottom-4 end-4 z-50">
      {message ? (
        <p className="animate-rise rounded-xl bg-ink px-4 py-2.5 font-medium text-surface shadow-lg">
          {message}
        </p>
      ) : null}
    </div>
  );
}
