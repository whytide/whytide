// The sign-in form: POST /v1/sign-in, which answers 202 to every email alike, then /sign-in/sent
// whatever the email was, so the screen tells no invited email from another. Only a refused request,
// an email the api does not take or too many asks, stays here with its error.
"use client";

import { Button, TextField } from "@whytide/ui";
import { ArrowRight } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

export function SignInForm({ next }: { next?: string }) {
  const t = useTranslations("identity.sign_in");
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    const body = next === undefined ? { email } : { email, next };
    const { response } = await browserApi().POST("/v1/sign-in", { body });
    if (response.ok) return router.push("/sign-in/sent");
    setSending(false);
    setError(response.status === 400 ? t("invalid") : t("failed"));
  }
  return (
    <form onSubmit={send} className="grid gap-4">
      <TextField
        name="email"
        type="email"
        required
        autoComplete="email"
        label={t("email")}
        error={error}
      />
      <Button type="submit" variant="primary" loading={sending}>
        {t("send")}
        <ArrowRight aria-hidden="true" className="rtl:-scale-x-100" />
      </Button>
    </form>
  );
}
