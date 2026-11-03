// The smtp adapter (README.md): the app's mail through nodemailer, imported here only, to the relay
// SMTP_HOST names, the shared stack's Mailpit in development (deploy/README.md). nodemailer 10.1.7
// is past 10.1.4, which fixed three advisories of 2026-10-19 in its address parser. The rule stays
// as a defense in depth: no address reaches nodemailer as a string; the port checked `to`, the
// configuration checks MAIL_FROM, and both go as objects to the headers and to the SMTP envelope,
// which skips that parser.
import { AppError, defineConfig, secret } from "@whytide/platform";
import { createTransport } from "nodemailer";
import { z } from "zod";
import { defineAdapter } from "../../_pattern/index.ts";
import { appMailPort, plainAddress } from "../port.ts";

/** The variables of deploy/.env.example's app-mail block, read when the adapter starts: a missing one fails then, naming itself. */
function smtpConfig() {
  const config = defineConfig("packages/providers", {
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: secret(z.string().min(1).optional()),
    MAIL_FROM: plainAddress,
  });
  if ((config.SMTP_USER === undefined) !== (config.SMTP_PASSWORD === undefined)) {
    const variables = ["SMTP_USER, SMTP_PASSWORD: both or neither"];
    throw new AppError("config_invalid", { details: { block: "packages/providers", variables } });
  }
  return config;
}

/** Failures before anything reached the server: no connection, no name, no TLS. */
const UNREACHABLE = new Set(["ECONNECTION", "ESOCKET", "ETIMEDOUT", "EDNS", "ETLS", "EPROXY"]);

/**
 * nodemailer's failure as a port code, with its own code and the SMTP reply code, never its message
 * (it quotes the address). A login refused for good (EAUTH, 535) is the operator's configuration, not
 * the mail, so it goes unmapped with anything else.
 */
function portError(error: unknown): unknown {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const reply = typeof responseCode === "number" ? responseCode : 0;
  const details = {
    code: typeof code === "string" ? code : undefined,
    responseCode: reply || undefined,
  };
  if (UNREACHABLE.has(details.code ?? "") || (reply >= 400 && reply < 500)) {
    return new AppError(appMailPort.errors.mail_unreachable, { details });
  }
  if (reply >= 500 && details.code !== "EAUTH") {
    return new AppError(appMailPort.errors.mail_rejected, { details });
  }
  return error;
}

export const smtpAdapter = defineAdapter(appMailPort, {
  name: "smtp",
  create: () => {
    const config = smtpConfig();
    const from = { name: "", address: config.MAIL_FROM };
    const transport = createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      // Implicit TLS on 465; elsewhere STARTTLS when the server offers it, required once a password goes.
      secure: config.SMTP_PORT === 465,
      requireTLS: config.SMTP_USER !== undefined,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      // A stalled relay fails send in seconds, not in nodemailer's minutes.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      // A mail is the strings send was given: nodemailer reads no file and fetches no URL into it.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return {
      send: async ({ to, subject, text, html }) => {
        const recipient = { name: "", address: to };
        const envelope = { from, to: [recipient] };
        try {
          const info = await transport.sendMail({
            from,
            to: recipient,
            envelope,
            subject,
            text,
            html,
          });
          return { messageId: info.messageId.replace(/^<(.*)>$/, "$1") };
        } catch (error) {
          throw portError(error);
        }
      },
    };
  },
});
