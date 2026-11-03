// The reply mail's constants (README.md "The reply mail"), beside their readers, mail.ts and the
// module's events.ts: the workflow's id, the thread's address in the web app and the first name a
// mail may carry.

/** inbox_reply_mail's id is `<MAIL_WORKFLOW>:<workspaceId>:<messageId>`: one run per reply. */
export const MAIL_WORKFLOW = "inbox.reply_mail";
/** The web app's origin: the api's variable, which the worker reads too. Empty: no link. */
export const ORIGIN_VARIABLE = "APP_PUBLIC_ORIGIN";
/** A workspace's pages in the web app sit under `/w/<workspaceId>`. */
export const WORKSPACE_PATH = "/w";
/** A thread's page under its workspace's: `inbox/<threadId>` (beta-p5-040's screen). */
export const INBOX_PATH = "inbox";
/** The longest first name a mail carries, in characters; a longer one is "a lead", as none is. */
export const MAIL_NAME_MAX = 50;
