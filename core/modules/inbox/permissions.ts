// The permission actions this module declares; platform assembles them at start (docs/rules/coding.md §3).
// inbox.read guards the threads and their messages, inbox.label a reply's label, inbox.reply a
// member's reply from the inbox on their own thread (README.md "API"); inbox.export the reply golden
// set's route, Owner only with Admin declared beside, as exports are (F18 §4; gamma-p7-060).
import { definePermissions } from "@whytide/platform";

export const permissions = definePermissions(
  [
    { action: "inbox.export", roles: ["Owner", "Admin"] },
    { action: "inbox.read", roles: ["Owner", "Admin", "Member"] },
    { action: "inbox.label", roles: ["Owner", "Admin", "Member"] },
    { action: "inbox.reply", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);
