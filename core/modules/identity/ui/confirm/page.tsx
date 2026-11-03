// /sign-in/confirm, the confirm step (core/packages/providers/auth/README.md "The sign-in link"): a
// link's GET lands here with the link in `link` and signs no one in, so a mail scanner that opens it
// spends nothing; the button POSTs the link from this page, and that signs in. A `link` on neither
// adapter's verify path (Better Auth's VERIFY_PATH, the fake's LINK_PATH) goes to /sign-in/expired.
// Its URL carries the token: proxy.ts sends it with Referrer-Policy: no-referrer.
import { Button, PublicPage } from "@whytide/ui";
import { ShieldCheck } from "@whytide/ui/icons";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const LINK = /^\/api\/auth\/(?:magic-link|fake)\/verify\?[\x21-\x7e]+$/;

export default async function SignInConfirm({ searchParams }: Props) {
  const { link } = await searchParams;
  if (typeof link !== "string" || !LINK.test(link)) redirect("/sign-in/expired");
  const t = await getTranslations("identity.sign_in.confirm");
  return (
    <PublicPage
      panel
      icon={<ShieldCheck aria-hidden="true" />}
      title={t("title")}
      description={t("body")}
    >
      <form method="post" action={link} className="grid">
        <Button type="submit" variant="primary">
          {t("submit")}
        </Button>
      </form>
    </PublicPage>
  );
}
