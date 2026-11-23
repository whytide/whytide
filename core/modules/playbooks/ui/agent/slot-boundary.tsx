// One slot of the agent's page (page.tsx; README.md "Screens"): its panels, another module's, behind
// an error boundary, so that one that throws leaves the agent and the other slots up (gamma-p3-065,
// as contacts' lead page does). While a panel answers, the slot shows the shared loading state.
// React catches a render error in a class component only. A failed slot shows the code in words
// (its digest, `api:<code>`, as the host's error.tsx reads it) and Try again, which renders the slot
// anew in the browser, so a panel's own read runs again. playbooks has no `next` dependency: a panel
// here calls neither notFound() nor redirect(), which this boundary would hold as a failure.
"use client";

import { ErrorState, LoadingState } from "@whytide/ui";
import { errorOwner } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { Component, type ReactNode, Suspense } from "react";

type Failure = Error & { digest?: string };

export class SlotBoundary extends Component<{ children: ReactNode }, { failed?: Failure }> {
  override state: { failed?: Failure } = {};

  static getDerivedStateFromError(error: unknown) {
    return { failed: error as Failure };
  }

  override render() {
    const { failed } = this.state;
    if (failed === undefined) {
      return <Suspense fallback={<LoadingState />}>{this.props.children}</Suspense>;
    }
    return <SlotFailed error={failed} retry={() => this.setState({ failed: undefined })} />;
  }
}

function SlotFailed({ error, retry }: { error: Failure; retry: () => void }) {
  const t = useTranslations("playbooks.agent");
  const { module, code } = errorOwner(error, useMessages());
  return (
    <div className="grid gap-3">
      <p className="font-medium text-ink">{t("slot_failed")}</p>
      <ErrorState module={module} code={code} onRetry={retry} />
    </div>
  );
}
