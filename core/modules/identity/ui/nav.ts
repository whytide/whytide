// identity's screens (core/apps/web/docs/screens.md): the invites at /w/{workspace}/invites, in the
// Company group after tenancy's members (gamma-p6-020); the public pages, outside the workspaces, that
// `pnpm web:routes` mounts at their path, the invite mail's /invitations among them; and the account
// menu it puts in the shell's `sign-out` slot.
export const nav = [
  {
    group: "company",
    labelKey: "identity.nav.invites",
    segment: "invites",
    screen: "invites",
    order: 30,
    icon: "UserPlus",
  },
];
export const publicPages = [
  { path: "sign-in", screen: "sign-in" },
  { path: "sign-in/sent", screen: "sent" },
  { path: "sign-in/expired", screen: "expired" },
  { path: "sign-in/confirm", screen: "confirm" },
  { path: "invitations", screen: "invitations" },
];
export const slots = [{ slot: "sign-out", screen: "account" }];
