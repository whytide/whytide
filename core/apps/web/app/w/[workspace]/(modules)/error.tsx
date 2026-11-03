// A screen that throws: ErrorState with the error's code in words, from the module that owns the code
// (src/api/errors.ts errorOwner), and a retry that renders the screen again.
"use client";

import { ErrorState, PageHeader } from "@whytide/ui";
import { useMessages, useTranslations } from "next-intl";
import { errorOwner } from "../../../../src/api/errors.ts";

type Props = { error: Error & { digest?: string }; retry: () => void };

export default function ScreenError({ error, retry }: Props) {
  const t = useTranslations("web");
  const { module, code } = errorOwner(error, useMessages());
  return (
    <>
      <PageHeader title={t("error.title")} />
      <ErrorState module={module} code={code} onRetry={retry} />
    </>
  );
}
