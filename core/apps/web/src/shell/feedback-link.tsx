// The header's feedback link (alpha-p10-040; core/modules/tenancy/README.md "Settings"): tenancy's
// FEEDBACK_URL, which GET /v1/me answers as feedbackUrl and the workspace layout passes from its
// own call, opened in a new tab without the opener or the referrer. None while it is unset. Its words
// show from 768 px wide; the icon stands for them below.
import { ButtonLink } from "@whytide/ui";
import { MessageSquareText } from "@whytide/ui/icons";
import { getTranslations } from "next-intl/server";

export async function FeedbackLink({ url }: { url: string | null }) {
  if (!url) return null;
  const t = await getTranslations("tenancy.feedback");
  return (
    <ButtonLink href={url} target="_blank" rel="noopener noreferrer" variant="ghost" size="sm">
      <MessageSquareText aria-hidden="true" />
      <span className="sr-only md:not-sr-only">{t("link")}</span>
    </ButtonLink>
  );
}
