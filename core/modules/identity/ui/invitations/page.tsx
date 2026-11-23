// /invitations, a public page (ui/nav.ts publicPages), where the invite mail's link lands, outside any
// workspace: the caller's own open invites, which invitations.tsx reads in the browser, or the way to
// sign in without a session (README.md "Invites").
import { PublicPage } from "@whytide/ui";
import { MailOpen } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";
import { Invitations } from "./invitations.tsx";

export default async function IdentityInvitations() {
  const t = await getTranslations("identity.invitations");
  return (
    <PublicPage icon={<MailOpen aria-hidden="true" />} title={t("title")}>
      <Invitations />
    </PublicPage>
  );
}
