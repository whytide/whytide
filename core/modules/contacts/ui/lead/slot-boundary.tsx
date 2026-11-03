// One slot of the lead page (view.tsx's place(); README.md "Screens"): its panels, another
// module's, behind an error boundary, so that one that throws leaves the page and the other slots
// up. While a panel's module answers, the slot shows the shared loading state. React catches a
// render error in a class component only; the Suspense also lets the server render the rest of the
// page when a panel fails there, where no boundary catches (React's), and the browser then renders
// the slot, which the boundary catches. A failed slot shows the code in words (its digest,
// `api:<code>`, as the host's error.tsx reads it) and a retry, which renders the page's panels
// again on the server and the slot anew. Next.js's notFound() and redirect() pass through to its
// own boundaries, as its error boundary lets them.
"use client";

import { ErrorState, LoadingState } from "@whytide/ui";
import { errorOwner } from "@whytide/web/api/browser";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useMessages, useTranslations } from "next-intl";
import { Component, type ReactNode, Suspense, startTransition } from "react";

type Failure = Error & { digest?: string };

export class SlotBoundary extends Component<{ children: ReactNode }, { failed?: Failure }> {
  override state: { failed?: Failure } = {};

  static getDerivedStateFromError(error: unknown) {
    unstable_rethrow(error);
    return { failed: error as Failure };
  }

  override render() {
    const { failed } = this.state;
    if (failed === undefined) {
      return <Suspense fallback={<LoadingState />}>{this.props.children}</Suspense>;
    }
    return <SlotFailed error={failed} reset={() => this.setState({ failed: undefined })} />;
  }
}

function SlotFailed({ error, reset }: { error: Failure; reset: () => void }) {
  const t = useTranslations("contacts.lead");
  const router = useRouter();
  const { module, code } = errorOwner(error, useMessages());
  // The page's server components again, then the slot: one transition, as Next.js retries a route.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <div className="grid gap-3">
      <p className="font-medium text-ink">{t("slot_failed")}</p>
      <ErrorState module={module} code={code} onRetry={retry} />
    </div>
  );
}
