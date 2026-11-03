// The host's two sign-in routes (README "Sign-in"), on the authentication port: asking for a link,
// public, which a module cannot mark (principal.ts), and signing out. Asking answers 202 to every
// well-formed email alike, invited or not, and asks the port for the link only once the answer is
// sent: neither the status, the body nor the time tells an invited email from another. It counts per
// client address, as the /api/auth/* routes do, and per email (docs/security.md "Rate limits").
import { createHmac, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { defineConfig, isAppError, type Logger, secret } from "@whytide/platform";
import {
  authPort,
  authRedirectPath,
  authSessionCookie,
  type PortInstance,
} from "@whytide/providers";
import { z } from "zod";
import { ApiRoute } from "../openapi/route.ts";
import { Public } from "./principal.ts";
import { protectionErrors } from "./protection/errors.ts";
import { addressKey, type RateLimiter } from "./protection/rate-limit.ts";
import { type HostRequest, requestState } from "./request-context.ts";

export const SIGN_IN = Symbol("sign-in");
export type SignIn = {
  readonly auth: PortInstance<typeof authPort>;
  readonly limiter: RateLimiter;
  readonly log: Logger;
};

/**
 * The key of the per-email limit's HMAC, so that Redis never holds a hash anyone can recompute from
 * an email: derived from AUTH_SECRET, the authentication's own secret, which production requires of
 * the Better Auth adapter, so every api process keys alike; unset elsewhere, a random one per process,
 * as that adapter does. Not HASH_SALT: contacts' setting, for person hashes, which the host never reads.
 */
const { AUTH_SECRET } = defineConfig("packages/providers", {
  AUTH_SECRET: secret(z.string().min(32).optional()),
});
const EMAIL_KEY = createHmac("sha256", AUTH_SECRET ?? randomBytes(32))
  .update("api: the sign-in limit per email")
  .digest();

const signInBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  /** Where to land once signed in, a path inside the app; `/` (the first workspace) otherwise. */
  next: z.string().max(2048).optional(),
});
type SignInBody = z.infer<typeof signInBody>;

/** The session cookie, emptied and expired: the browser drops it. */
function clearedCookie(): string {
  const { name, path, sameSite, secure } = authSessionCookie;
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=${sameSite}${secure ? "; Secure" : ""}`;
}

@Controller("v1")
export class SignInController {
  readonly #signIn: SignIn;

  constructor(@Inject(SIGN_IN) signIn: SignIn) {
    this.#signIn = signIn;
  }

  @Public()
  @Post("sign-in")
  @HttpCode(202)
  @ApiRoute({
    summary: "Mails a sign-in link to an invited email; answers every email alike, before mailing",
    body: signInBody,
    errors: [protectionErrors.rate_limited],
  })
  async requestLink(
    @Body() body: SignInBody,
    @Req() req: HostRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    const { auth, limiter, log } = this.#signIn;
    await limiter.enforce("auth", addressKey(req), res);
    const emailKey = createHmac("sha256", EMAIL_KEY).update(body.email).digest("hex").slice(0, 32);
    await limiter.enforce("email", emailKey, res);
    const next = authRedirectPath.safeParse(body.next);
    const request = { email: body.email, redirectTo: next.success ? next.data : "/" };
    res.once("finish", () => {
      auth.requestMagicLink(request).catch((error: unknown) => {
        const code = isAppError(error) ? error.code : "unknown";
        // A refused email is the invite-only rule at work; anything else is logged by its code only.
        if (code !== authPort.errors.auth_invite_required) {
          log.warn({ code }, "api: a sign-in link was not sent");
        }
      });
    });
  }

  @Post("sign-out")
  @HttpCode(204)
  @ApiRoute({ summary: "Ends every session of the signed-in user, this browser's included" })
  async signOut(
    @Req() req: HostRequest,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<void> {
    const userId = requestState(req).principal?.userId ?? "";
    await this.#signIn.auth.signOutEverywhere(userId);
    res.setHeader("set-cookie", clearedCookie());
  }
}
