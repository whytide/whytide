// The app-mail port's test helpers (README.md "Reading the mail"). readMailpit({ to }) reads the latest
// mail to an address from Mailpit's API, the shared stack's one inbox (deploy/README.md), for the smtp
// contract suite, the sign-in tests and the smoke test. Mailpit is shared by every worktree on the
// laptop: a test sends to a fresh address, reads that address only and deletes nothing. The fetch
// calls pass no-raw-fetch because tools/lint allows the global fetch in test code, which includes a
// port's testing/ folder; they reach the stack's Mailpit and nothing else.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { asRead, type DeliveredMail } from "../contract.ts";

let loaded = false;

/** The worktree's .env.local (`pnpm env:create`), loaded once and never over the environment, as core/packages/db does. */
export function loadEnvLocal(): void {
  if (loaded) return;
  loaded = true;
  for (let dir = import.meta.dirname; dirname(dir) !== dir; dir = dirname(dir)) {
    if (!existsSync(join(dir, "pnpm-workspace.yaml"))) continue;
    if (existsSync(join(dir, ".env.local"))) process.loadEnvFile(join(dir, ".env.local"));
    return;
  }
}

// A list Mailpit leaves empty may come as null.
const addresses = z.array(z.object({ Address: z.string() })).nullable();
const found = z.object({ messages: z.array(z.object({ ID: z.string(), To: addresses })) });
const message = z.object({
  MessageID: z.string(),
  To: addresses,
  Cc: addresses,
  Bcc: addresses,
  Subject: z.string(),
  Text: z.string(),
  HTML: z.string(),
});

/** The latest mail to `to` in Mailpit, waited for up to `timeoutMs`; fails when none arrives. */
export async function readMailpit(
  { to }: { readonly to: string },
  { timeoutMs = 5_000 } = {},
): Promise<DeliveredMail> {
  loadEnvLocal();
  const { MAILPIT_API_URL: api } = defineConfig("packages/providers", {
    MAILPIT_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  });
  if (!api) throw new Error("MAILPIT_API_URL is not set: run pnpm env:create --force here");
  const get = async (path: string) => {
    const response = await fetch(new URL(path, api.endsWith("/") ? api : `${api}/`));
    if (!response.ok)
      throw new Error(`Mailpit answered ${response.status} to ${path.split("?")[0]}`);
    return response.json();
  };
  const search = `api/v1/search?${new URLSearchParams({ query: `to:"${to}"` })}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Newest first; `to:` matches a part of an address, so the address is compared in full here.
    const { messages } = found.parse(await get(search));
    const latest = messages.find(({ To }) =>
      (To ?? []).some((a) => a.Address.toLowerCase() === to.toLowerCase()),
    );
    if (latest) {
      const mail = message.parse(await get(`api/v1/message/${encodeURIComponent(latest.ID)}`));
      // Mailpit lists an envelope recipient that no header names under Bcc.
      const recipients = [mail.To, mail.Cc, mail.Bcc].flatMap((list) =>
        (list ?? []).map((a) => a.Address),
      );
      const html = mail.HTML ? { html: mail.HTML } : {};
      const text = asRead(mail.Text);
      return { messageId: mail.MessageID, recipients, subject: mail.Subject, text, ...html };
    }
    if (Date.now() > deadline)
      throw new Error(`no mail to that address in Mailpit after ${timeoutMs} ms`);
    await delay(100);
  }
}
