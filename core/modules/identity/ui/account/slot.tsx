// The account menu in the shell's header (the `sign-out` slot, ui/nav.ts): the member's email, the
// theme (system, light or dark), and Sign out, which ends every session of the user (POST
// /v1/sign-out) and goes to /sign-in. On a phone the button shows the avatar only; the email stays
// its name, and the menu shows it.
"use client";

import { Avatar, Menu, MenuItem, ThemeToggle } from "@whytide/ui";
import { LogOut } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";

export default function Account({ email }: { email: string }) {
  const t = useTranslations("identity.account");
  async function signOut() {
    await browserApi().POST("/v1/sign-out");
    window.location.assign("/sign-in");
  }
  return (
    <Menu
      trigger={
        <>
          <Avatar name={email} />
          <span className="sr-only max-w-48 truncate sm:not-sr-only">{email}</span>
        </>
      }
    >
      <div className="grid gap-0.5 px-2.5 pt-1.5 pb-3">
        <p className="text-xs text-ink-muted">{t("signed_in")}</p>
        <p className="truncate font-medium text-ink">{email}</p>
      </div>
      <div className="border-t border-line px-2.5 pt-2.5 pb-3">
        <ThemeToggle />
      </div>
      <div className="border-t border-line pt-1.5">
        <MenuItem onClick={signOut}>
          <LogOut aria-hidden="true" className="rtl:-scale-x-100" />
          {t("sign_out")}
        </MenuItem>
      </div>
    </Menu>
  );
}
