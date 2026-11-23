// email's screens (core/apps/web/docs/screens.md): the mailboxes screen in the email group, and the
// callback page outside the workspaces, at the one fixed address the providers send the consent back
// to (README.md "Screen"), CALLBACK_PATH without its leading slash.
import { CALLBACK_PATH } from "../domain/constants.ts";

export const nav = [
  {
    group: "email",
    labelKey: "email.nav.mailboxes",
    segment: "mailboxes",
    screen: "mailboxes",
    order: 10,
    icon: "Mail",
  },
];
export const publicPages = [{ path: CALLBACK_PATH.slice(1), screen: "callback" }];
