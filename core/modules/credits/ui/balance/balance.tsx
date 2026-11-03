// The balance's text, kept fresh: the first value comes from the page's load (slot.tsx), and each
// navigation to another page reads it again from the browser. A failed read keeps the last value.
// It links to the costs page (ui/costs/).
"use client";

import { Link } from "@whytide/ui";
import { Coins } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

type Props = { workspaceId: string; initial: string | undefined };

export function Balance({ workspaceId, initial }: Props) {
  const t = useTranslations("credits.balance");
  const pathname = usePathname();
  const [available, setAvailable] = useState(initial);
  const readAt = useRef(pathname);
  useEffect(() => {
    if (readAt.current === pathname) return;
    readAt.current = pathname;
    let current = true;
    const request = { params: { path: { workspaceId } } };
    browserApi()
      .GET("/v1/workspaces/{workspaceId}/credits/balance", request)
      .then(
        ({ data }) => current && data && setAvailable(data.available),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [pathname, workspaceId]);
  if (available === undefined) return null;
  return (
    <Link href={`/w/${workspaceId}/credits`}>
      <Coins aria-hidden="true" className="size-3.5 shrink-0 text-accent-ink" />
      {t("label", { available: Number(available) })}
    </Link>
  );
}
