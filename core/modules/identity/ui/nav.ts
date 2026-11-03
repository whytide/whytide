// identity's screens (core/apps/web/docs/screens.md): no navigation entry; the public pages, outside
// the workspaces, that `pnpm web:routes` mounts at their path, and the account menu it puts in the
// shell's `sign-out` slot.
export const publicPages = [
  { path: "sign-in", screen: "sign-in" },
  { path: "sign-in/sent", screen: "sent" },
  { path: "sign-in/expired", screen: "expired" },
  { path: "sign-in/confirm", screen: "confirm" },
];
export const slots = [{ slot: "sign-out", screen: "account" }];
