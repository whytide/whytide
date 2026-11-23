// next-intl's configuration of a request (README "Routes"): the bundle `pnpm web:routes` merged from
// every messages/en.json, in the default locale; the user's setting and the browser come later. The
// time zone is the viewer's, from the cookie the shell writes (README "The shell"; gamma-en-100);
// until it is known, the server's own. A screen that passes its own zone to a format keeps it.
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { TIME_ZONE_COOKIE } from "../../constants.ts";
import bundle from "./messages.generated.json";
import { timeZoneOf } from "./time-zone.ts";

export default getRequestConfig(async () => {
  const timeZone = timeZoneOf((await cookies()).get(TIME_ZONE_COOKIE)?.value);
  return {
    locale: bundle.locale,
    messages: bundle.messages,
    ...(timeZone !== undefined && { timeZone }),
  };
});
