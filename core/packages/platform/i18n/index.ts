// The i18n runtime (alpha-p1-080): the bundle, the translator, mail, the formats and the locale.
// The message-key check, check.ts and uses.ts, runs as `pnpm -F platform messages:check` and is not
// exported here: it needs the TypeScript compiler, which no host carries.
export { formatDate, formatNumber, formatRelative, type RelativeOptions } from "./format.ts";
export { formatIcu, type MessageValues, validateIcu } from "./icu.ts";
export { isMessageKey, type KeyResult, type ParsedKey, parseKey } from "./keys.ts";
export { canonicalLocale, defaultLocale, type ResolveOptions, resolveLocale } from "./locale.ts";
export { type Mail, type MailOptions, renderMail } from "./mail.ts";
export { buildMessages, type LoadOptions, loadMessages, type Messages } from "./messages.ts";
export {
  createTranslator,
  errorMessageKey,
  type TranslateFn,
  type Translator,
  translateError,
} from "./translator.ts";
