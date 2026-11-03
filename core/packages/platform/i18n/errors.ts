import { defineErrors } from "../errors/index.ts";

/**
 * The codes the i18n runtime throws, as `AppError`s with what is needed to find the fault in
 * `details` (coding §9): the locale, the message file and key, the files of a conflict.
 */
export const errors = defineErrors({
  invalid_locale: { status: 400 },
  invalid_messages: {},
  message_conflict: {},
  message_format_failed: {},
  message_not_found: {},
  workspace_root_not_found: {},
});
