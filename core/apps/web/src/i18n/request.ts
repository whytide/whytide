// next-intl's configuration of a request (README "Routes"): the bundle `pnpm web:routes` merged from
// every messages/en.json, in the default locale; the user's setting and the browser come later.
import { getRequestConfig } from "next-intl/server";
import bundle from "./messages.generated.json";

export default getRequestConfig(async () => ({ locale: bundle.locale, messages: bundle.messages }));
