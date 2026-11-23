// campaigns' panel in the outreach slot of contacts' lead page (ui/nav.ts `panels`; README.md
// "Screens"): the person's enrollments, newest first, read in the browser as the member through
// campaigns' own route, which carries the sender's time zone, so no other module is read. While it
// reads, the slot's loading state, the one its boundary shows; a failed read, the panel's error state
// with the code in words and Try again, which reads again; no enrollment, the empty state, which says
// that Approve starts the sequence. enrollment.tsx shows each one, with its Pause or Resume, after
// which, or after their refusal, the panel reads again in place (gamma-p3-061).
"use client";

import { Card, EmptyState, ErrorState, LoadingState } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { EnrollmentsResponse } from "../../schemas/enrollments.ts";
import { Enrollment } from "./enrollment.tsx";

type Read = EnrollmentsResponse | { readonly failed: string };
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export default function EnrollmentPanel(props: { workspace: string; personId: string }) {
  const { workspace, personId } = props;
  const t = useTranslations("campaigns.enrollment");
  const [read, setRead] = useState<Read>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    const params = { path: { workspaceId: workspace }, query: { personId } };
    return data(browserApi().GET("/v1/workspaces/{workspaceId}/campaigns/enrollments", { params }));
  }, [workspace, personId]);

  // One read per person, workspace and attempt; an earlier one that answers late is dropped.
  useEffect(() => {
    let live = true;
    setRead(undefined);
    load().then(
      (answer) => live && setRead(answer),
      (error: unknown) => live && setRead({ failed: codeOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);

  /** After a pause or a resume, or its refusal: the panel read again in place, its controls kept. */
  const reload = () => load().then(setRead, (error: unknown) => setRead({ failed: codeOf(error) }));

  if (read === undefined) return <LoadingState />;
  return (
    <Card title={t("title")}>
      {"failed" in read ? (
        <ErrorState
          module="campaigns"
          code={read.failed}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : read.enrollments.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <div className="grid divide-y divide-line">
          {read.enrollments.map((enrollment) => (
            <Enrollment
              key={enrollment.id}
              workspace={workspace}
              enrollment={enrollment}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
