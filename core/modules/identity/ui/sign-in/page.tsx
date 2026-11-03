// /sign-in: an email and Send. `next`, the page to land on once signed in, goes to the api as it is;
// the api checks it with the authentication port's authRedirectPath and falls back to /, the first
// workspace (README.md "Sign-in").
import { PublicPage } from "@whytide/ui";
import { getTranslations } from "next-intl/server";
import { SignInForm } from "./form.tsx";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignIn({ searchParams }: Props) {
  const { next } = await searchParams;
  const t = await getTranslations("identity.sign_in");
  return (
    <PublicPage panel title={t("title")} description={t("body")}>
      <SignInForm next={typeof next === "string" ? next : undefined} />
    </PublicPage>
  );
}
