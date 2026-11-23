// The viewer's time zone for next-intl (README "The shell"; gamma-en-100): the browser's own zone
// written to a cookie, which src/i18n/request.ts reads, so that the server renders dates in the
// viewer's day. A page rendered in another zone is read again once, when the cookie was just
// written; a cookie the browser keeps refused or the server does not take asks nothing more.
"use client";

import { useRouter } from "next/navigation";
import { useTimeZone } from "next-intl";
import { useEffect } from "react";
import { TIME_ZONE_COOKIE, TIME_ZONE_COOKIE_MAX_AGE, TIME_ZONE_PATTERN } from "../../constants.ts";

/** The zone the cookie holds, or undefined. */
function cookieZone(): string | undefined {
  const prefix = `${TIME_ZONE_COOKIE}=`;
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

export function TimeZone() {
  const rendered = useTimeZone();
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || !TIME_ZONE_PATTERN.test(zone) || cookieZone() === zone) return;
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${TIME_ZONE_COOKIE}=${zone}; path=/; max-age=${TIME_ZONE_COOKIE_MAX_AGE}; samesite=lax${secure}`;
    if (rendered !== zone) router.refresh();
  }, [rendered, router]);
  return null;
}
